import { runCarrierContract } from './carrier-contract.client.ts'
import { createWebCarrierContractHarness } from './web-carrier-contract-harness.client.ts'

runCarrierContract('HTTP/WebSocket', createWebCarrierContractHarness)
