import { runCarrierContract } from './carrier-contract.client.ts'
import { createDesktopCarrierContractHarness } from './desktop-carrier-contract-harness.client.ts'

runCarrierContract('Electron IPC', createDesktopCarrierContractHarness)
