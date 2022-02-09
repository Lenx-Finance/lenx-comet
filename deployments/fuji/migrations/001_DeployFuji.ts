import { ContractMap } from '../../../plugins/deployment_manager/ContractMap';
import { DeploymentManager } from '../../../plugins/deployment_manager/DeploymentManager';
import { Roots } from '../../../plugins/deployment_manager/Roots';
import { migration } from '../../../plugins/deployment_manager/Migration';
import { deployNetworkComet } from '../../../src/deploy/Network';
import { DeployedContracts } from '../../../src/deploy/index';
import { Contract } from 'ethers';
import { exp, wait } from '../../../test/helpers';
import { ProxyAdmin, ProxyAdmin__factory } from '../../../build/types';

interface TargetConfig {
  name: string;
  address: string;
  network: string;
  args: any[];
  alias?: string;
}

async function clone<C extends Contract>(
  deploymentManager: DeploymentManager,
  target: TargetConfig,
  initializer: (C) => Promise<void> = () => null
): Promise<C> {
  let contracts = await deploymentManager.contracts();

  if (!process.env['REDEPLOY'] && target.alias && contracts.has(target.alias)) {
    console.log(`Skipping already existing contract: ${target.alias}`);
    return contracts.get(target.alias) as C;
  }

  console.log(`Importing ${target.name}`);
  let buildFile = await deploymentManager.import(target.address, target.network);
  console.log(`Deploying ${target.name} ${JSON.stringify(target.args)}`);
  let contract = await deploymentManager.deployBuild(buildFile, target.args);
  console.log(`Deployed ${target.name} to ${contract.address}`);

  if (target.alias) {
    console.log(`Setting alias from ${contract.address} to ${target.alias}`);
    await deploymentManager.putAlias(target.alias, contract.address);
  }

  let deployed = (await contract.deployed()) as C;

  await initializer(deployed);

  return deployed;
}

async function sleep(timeout) {
  await new Promise((resolve) => setTimeout(resolve, timeout));
}

migration<DeployedContracts>('001_DeployFuji', {
  prepare: async (deploymentManager: DeploymentManager) => {
    deploymentManager.shouldWriteCacheToDisk(false);

    let [signer] = await deploymentManager.hre.ethers.getSigners();
    let signerAddress = await signer.getAddress();

    let usdcProxyAdminArgs: [] = [];
    let usdcProxyAdmin = await deploymentManager.deploy<ProxyAdmin, ProxyAdmin__factory, []>(
      'vendor/proxy/ProxyAdmin.sol',
      usdcProxyAdminArgs
    );

    let usdcImplementation = await clone(deploymentManager, {
      name: 'USDCImplementation',
      address: '0xa3fa3d254bf6af295b5b22cc6730b04144314890',
      network: 'avalanche',
      args: [],
      alias: 'USDCImplementation',
    });

    let usdc;
    let usdcProxy = await clone(
      deploymentManager,
      {
        name: 'USDC',
        address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
        network: 'avalanche',
        args: [usdcImplementation.address],
        alias: 'USDC',
      },
      async (usdcProxy) => {
        await wait(await usdcProxy.changeAdmin(usdcProxyAdmin.address));
        usdc = usdcImplementation.attach(usdcProxy.address);
        // Give signer 10,000 USDC
        await wait(
          usdc.initialize(
            'USD Coin',
            'USDC',
            'USD',
            6,
            signerAddress,
            signerAddress,
            signerAddress,
            signerAddress
          )
        );
        await wait(usdc.configureMinter(signerAddress, exp(10000, 6)));
        await wait(usdc.mint(signerAddress, exp(10000, 6)));
      }
    );

    let wbtc = await clone(
      deploymentManager,
      {
        name: 'WBTC.e',
        address: '0x50b7545627a5162f82a992c33b87adc75187b218',
        network: 'avalanche',
        args: [],
        alias: 'WBTC.e',
      },
      async (wbtc) => {
        // Give signer 1000 WBTC
        await wait(
          wbtc.mint(
            signerAddress,
            exp(1000, 8),
            '0x0000000000000000000000000000000000000000',
            0,
            '0x0000000000000000000000000000000000000000000000000000000000000000'
          )
        );
      }
    );

    let wavax = await clone(
      deploymentManager,
      {
        name: 'WAVAX',
        address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
        network: 'avalanche',
        args: [],
        alias: 'WAVAX',
      },
      async (wavax) => {
        // Give admin 0.01 WAVAX tokens [this is a precious resource here!]
        await wait(wavax.deposit({ value: exp(0.01, 18) }));
      }
    );

    // Contracts referenced in `configuration.json`.
    let contracts: ContractMap = new Map([
      ['USDC', usdc],
      ['WBTC.e', wbtc],
      ['WAVAX', wavax],
    ]);

    return await deployNetworkComet(deploymentManager, true, {}, contracts);
  },
  enact: async (deploymentManager: DeploymentManager, contracts) => {
    deploymentManager.shouldWriteCacheToDisk(true);

    console.log(
      'Enacting by changing root... This only makes sense for the initial migration or a "reset".'
    );
    let roots: Roots = new Map();
    roots.set('comet', contracts['proxy'].address);
    await deploymentManager.putRoots(roots);
    console.log('Enacted...');
  },
});