import { Fetcher, FetcherConstructor } from "./types";
import * as Types from "./types";
import { networksById, makeFilename, makeTimer } from "./common";
import request from "request-promise-native";

//this looks awkward but the TS docs actually suggest this :P
const EtherscanFetcher: FetcherConstructor = class EtherscanFetcher
  implements Fetcher {
  get name(): string {
    return "etherscan";
  }

  static async forNetworkId(id: number): Promise<EtherscanFetcher> {
    return new EtherscanFetcher(id);
  }

  private readonly apiKey: string;
  private readonly timeout: number; //minimum # of ms to wait between requests

  private ready: Promise<void>; //always await this timer before making a request.
  //then, afterwards, start a new timer.

  constructor(networkId: number) {
    const networkName = networksById[networkId];
    const supportedNetworks = [
      "mainnet",
      "ropsten",
      "kovan",
      "rinkeby",
      "goerli"
    ];
    if (networkName === undefined || !supportedNetworks.includes(networkName)) {
      this.validNetwork = false;
    } else {
      this.validNetwork = true;
      this.suffix = networkName === "mainnet" ? "" : `-${networkName}`;
    }
    this.apiKey = ""; //leaving out apiKey for now
    this.timeout = this.apiKey ? 200 : 334; //etherscan permits 5 requests/sec w/a key, 3/sec w/o
    this.ready = makeTimer(0); //at start, it's ready to go immediately
  }

  private validNetwork: boolean;
  private suffix: string;

  async isNetworkValid(): Promise<boolean> {
    return this.validNetwork;
  }

  async fetchSourcesForAddress(
    address: string
  ): Promise<Types.SourceInfo | null> {
    const response = await this.getSuccessfulResponse(address);
    return EtherscanFetcher.processResult(response.result[0]);
  }

  private async getSuccessfulResponse(
    address: string
  ): Promise<EtherscanSuccess> {
    const allowedAttempts = 2; //for now, we'll just retry once if it fails
    let lastError;
    for (let attempt = 0; attempt < allowedAttempts; attempt++) {
      await this.ready;
      const responsePromise = this.makeRequest(address);
      this.ready = makeTimer(this.timeout);
      //for now, we're just going to retry once if it fails
      try {
        return await responsePromise;
      } catch (error) {
        lastError = error;
        //just go back to the top of the loop to retry
      }
    }
    //if we've made it this far with no successful response, just
    //throw the last error
    throw lastError;
  }

  private async makeRequest(address: string): Promise<EtherscanSuccess> {
    //not putting a try/catch around this; if it throws, we throw
    const response: EtherscanResponse = await request({
      uri: `https://api${this.suffix}.etherscan.io/api`,
      qs: {
        module: "contract",
        action: "getsourcecode",
        address,
        apikey: this.apiKey
      },
      json: true //turns on auto-parsing :)
    });
    if (response.status === "0") {
      //no retry logic for now; will add later
      throw new Error(response.result);
    }
    return response;
  }

  private static processResult(
    result: EtherscanResult
  ): Types.SourceInfo | null {
    //we have 5 cases here.
    //case 1: the address doesn't exist
    if (
      result.SourceCode === "" &&
      result.ABI === "Contract source code not verified"
    ) {
      return null;
    }
    //case 2: it's a Vyper contract
    if (result.CompilerVersion.startsWith("vyper")) {
      //return nothing useful, just something saying it's
      //vyper so we can't do anything
      return {
        sources: {},
        options: {
          language: "Vyper",
          version: "",
          settings: {}
        }
      };
    }
    let sourceJson: Types.SolcSources | Types.SolcInput;
    try {
      sourceJson = JSON.parse(result.SourceCode);
    } catch (_) {
      //case 3: single source
      return this.processSingleResult(result);
    }
    //now: do we have a multi-result or a JSON-result?
    if (this.isFullJson(sourceJson)) {
      //case 5: full JSON input
      return this.processJsonResult(result, sourceJson);
    } else {
      //case 4: multiple sources
      return this.processMultiResult(result, sourceJson);
    }
  }

  private static isFullJson(
    sourceJson: Types.SolcSources | Types.SolcInput
  ): sourceJson is Types.SolcInput {
    return (<Types.SolcInput>sourceJson).language === "Solidity";
  }

  private static processSingleResult(
    result: EtherscanResult
  ): Types.SourceInfo {
    const filename = makeFilename(result.ContractName);
    return {
      sources: {
        [filename]: result.SourceCode
      },
      options: {
        language: "Solidity",
        version: result.CompilerVersion,
        settings: this.extractSettings(result)
      }
    };
  }

  private static processMultiResult(
    result: EtherscanResult,
    sources: Types.SolcSources
  ): Types.SourceInfo {
    return {
      sources: this.processSources(sources),
      options: {
        language: "Solidity",
        version: result.CompilerVersion,
        settings: this.extractSettings(result)
      }
    };
  }

  private static processJsonResult(
    result: EtherscanResult,
    jsonInput: Types.SolcInput
  ): Types.SourceInfo {
    return {
      sources: this.processSources(jsonInput.sources),
      options: {
        language: "Solidity",
        version: result.CompilerVersion,
        settings: this.removeLibraries(jsonInput.settings)
      }
    };
  }

  private static processSources(
    sources: Types.SolcSources
  ): Types.SourcesByPath {
    return Object.assign(
      {},
      ...Object.entries(sources).map(([path, { content: source }]) => ({
        [makeFilename(path)]: source
      }))
    );
  }

  private static extractSettings(result: EtherscanResult): Types.SolcSettings {
    const evmVersion: string =
      result.EVMVersion === "Default" ? undefined : result.EVMVersion;
    const optimizer = {
      enabled: result.OptimizationUsed === "1",
      runs: parseInt(result.Runs)
    };
    //old version got libraries here, but we don't actually want that!
    if (evmVersion !== undefined) {
      return {
        optimizer,
        evmVersion
      };
    } else {
      return {
        optimizer
      };
    }
  }

  //we *don't* want to pass library info!  unlinked bytecode is better!
  private static removeLibraries(
    settings: Types.SolcSettings
  ): Types.SolcSettings {
    let copySettings: Types.SolcSettings = { ...settings };
    delete copySettings.libraries;
    return copySettings;
  }
};

type EtherscanResponse = EtherscanSuccess | EtherscanFailure;

interface EtherscanSuccess {
  status: "1";
  message: string;
  result: EtherscanResult[];
}

interface EtherscanFailure {
  status: "0";
  message: string;
  result: string;
}

//apologies for this being stringly-typed, but that's how
//Etherscan does it
interface EtherscanResult {
  SourceCode: string; //really: string | SolcSources | SolcInput
  ABI: string; //really: it's the ABI [we won't use this]
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string; //really: a number used as a boolean
  Runs: string; //really: a number
  ConstructorArguments: string; //ignored
  EVMVersion: string;
  Library: string; //represents an object but not in JSON (we'll actually ignore this)
  LicenseType: string; //ignored
  Proxy: string; //no clue what this is [ignored]
  Implementation: string; //or this [ignored]
  SwarmSource: string; //ignored
}

export default EtherscanFetcher;