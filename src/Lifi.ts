/* eslint-disable @typescript-eslint/no-empty-function */
import { JsonRpcSigner } from '@ethersproject/providers'
import {
  Execution,
  PossibilitiesRequest,
  PossibilitiesResponse,
  Route,
  RoutesRequest,
  RoutesResponse,
  Step,
  StepTransactionResponse,
  Token,
  TokenAmount,
} from '@lifinance/types'
import axios from 'axios'
import { Signer } from 'ethers'

import balances from './balances'
import { StepExecutor } from './executionFiles/StepExecutor'
import { isRoutesRequest, isStep, isToken } from './typeguards'
import { CallbackFunction } from './types'

interface ExecutionData {
  route: Route
  executors: StepExecutor[]
  callbackFunction: CallbackFunction
}
interface ActiveRouteDictionary {
  [k: string]: ExecutionData
}

class LIFI {
  private activeRoutes: ActiveRouteDictionary = {}
  private config = {
    apiUrl: process.env.REACT_APP_API_URL || 'https://test.li.finance/api/',
  }

  getPossibilities = async (
    request?: PossibilitiesRequest
  ): Promise<PossibilitiesResponse> => {
    const result = await axios.post<PossibilitiesResponse>(
      this.config.apiUrl + 'possibilities',
      request
    )

    return result.data
  }

  getRoutes = async (routesRequest: RoutesRequest): Promise<RoutesResponse> => {
    if (!isRoutesRequest(routesRequest)) {
      throw new Error('SDK Validation: Invalid Routs Request')
    }

    const result = await axios.post<RoutesResponse>(
      this.config.apiUrl + 'routes',
      routesRequest
    )

    return result.data
  }

  getStepTransaction = async (step: Step): Promise<StepTransactionResponse> => {
    if (!isStep(step)) {
      // While the validation fails for some users we should not enforce it
      // eslint-disable-next-line no-console
      console.warn('SDK Validation: Invalid Step', step)
    }

    const result = await axios.post<StepTransactionResponse>(
      this.config.apiUrl + 'steps/transaction',
      step
    )

    return result.data
  }

  stopExecution = (route: Route): Route => {
    if (!this.activeRoutes[route.id]) return route
    for (const executor of this.activeRoutes[route.id].executors) {
      executor.stopStepExecution()
    }
    delete this.activeRoutes[route.id]
    return route
  }

  moveExecutionToBackground = (route: Route): void => {
    if (!this.activeRoutes[route.id]) return
    for (const executor of this.activeRoutes[route.id].executors) {
      executor.stopStepExecution()
    }
  }

  executeRoute = async (
    signer: Signer,
    route: Route,
    callback?: CallbackFunction
  ): Promise<Route> => {
    // check if route is already running
    if (this.activeRoutes[route.id]) return route
    const execData: ExecutionData = {
      route,
      executors: [],
      callbackFunction: callback ? callback : () => {},
    }
    this.activeRoutes[route.id] = execData

    const updateFunction = (step: Step, status: Execution) => {
      step.execution = status
      this.activeRoutes[route.id].callbackFunction(route)
    }

    // loop over steps and execute them
    for (let index = 0; index < route.steps.length; index++) {
      //check if execution has stopped in meantime
      if (!this.activeRoutes[route.id]) break

      const step = route.steps[index]
      const previousStep = index !== 0 ? route.steps[index - 1] : undefined

      // check if signer is for correct chain
      if ((await signer.getChainId()) !== step.action.fromChainId) {
        break
      }

      // update amount using output of previous execution. In the future this should be handled by calling `updateRoute`
      if (
        previousStep &&
        previousStep.execution &&
        previousStep.execution.toAmount
      ) {
        step.action.fromAmount = previousStep.execution.toAmount
      }
      try {
        const stepExecutor = new StepExecutor()
        this.activeRoutes[route.id].executors.push(stepExecutor)
        await stepExecutor.executeStep(signer, step, updateFunction)
      } catch (e) {
        this.stopExecution(route)
        throw e
      }
    }

    // executeRoute = (signer: Signer, route: Route): Promise<Route> => {

    delete this.activeRoutes[route.id]
    return route
  }

  resumeRoute = async (
    signer: JsonRpcSigner,
    route: Route,
    callback?: CallbackFunction
  ): Promise<Route> => {
    const activeRoute = this.activeRoutes[route.id]
    if (activeRoute) {
      const executionHalted = activeRoute.executors.some(
        (executor) => executor.executionStopped
      )
      if (!executionHalted) return route
    }

    const execData: ExecutionData = {
      route,
      executors: [],
      callbackFunction: callback ? callback : () => {},
    }
    this.activeRoutes[route.id] = execData

    const updateFunction = (step: Step, status: Execution) => {
      step.execution = status
      this.activeRoutes[route.id].callbackFunction(route)
    }

    // loop over steps and execute them
    for (let index = 0; index < route.steps.length; index++) {
      //check if execution has stopped in meantime
      if (!this.activeRoutes[route.id]) break

      const step = route.steps[index]
      const previousStep = index !== 0 ? route.steps[index - 1] : undefined
      // check if step already done
      if (step.execution && step.execution.status === 'DONE') {
        continue
      }

      // check if signer is for correct chain
      if ((await signer.getChainId()) !== step.action.fromChainId) {
        break
      }

      // update amount using output of previous execution. In the future this should be handled by calling `updateRoute`
      if (
        previousStep &&
        previousStep.execution &&
        previousStep.execution.toAmount
      ) {
        step.action.fromAmount = previousStep.execution.toAmount
      }

      try {
        const stepExecutor = new StepExecutor()
        this.activeRoutes[route.id].executors.push(stepExecutor)
        await stepExecutor.executeStep(signer, step, updateFunction)
      } catch (e) {
        this.stopExecution(route)
        throw e
      }
    }

    //clean up after execution
    delete this.activeRoutes[route.id]
    return route
  }

  registerCallback = (
    callback: (updatedRoute: Route) => void,
    route: Route
  ): void => {
    this.activeRoutes[route.id].callbackFunction = callback
  }

  deregisterCallback = (
    callback: (updateRoute: Route) => void,
    route: Route
  ): void => {
    this.activeRoutes[route.id].callbackFunction = () => {}
  }

  getActiveRoutes = (): Route[] => {
    return Object.values(this.activeRoutes).map((dict) => dict.route)
  }

  getActiveRoute = (route: Route): Route | undefined => {
    return this.activeRoutes[route.id].route
  }

  // Balances
  getTokenBalance = async (
    walletAddress: string,
    token: Token
  ): Promise<TokenAmount | null> => {
    if (!walletAddress) {
      throw new Error('SDK Validation: Missing walletAddress')
    }

    if (!isToken(token)) {
      throw new Error('SDK Validation: Invalid token passed')
    }

    return balances.getTokenBalance(walletAddress, token)
  }

  getTokenBalances = async (
    walletAddress: string,
    tokens: Token[]
  ): Promise<TokenAmount[]> => {
    if (!walletAddress) {
      throw new Error('SDK Validation: Missing walletAddress')
    }

    if (!tokens.length) {
      throw new Error('SDK Validation: Empty token list passed')
    }

    if (tokens.filter((token) => !isToken(token)).length) {
      throw new Error('SDK Validation: Invalid token passed')
    }

    return balances.getTokenBalances(walletAddress, tokens)
  }

  getTokenBalancesForChains = async (
    walletAddress: string,
    tokensByChain: { [chainId: number]: Token[] }
  ): Promise<{ [chainId: number]: TokenAmount[] }> => {
    if (!walletAddress) {
      throw new Error('SDK Validation: Missing walletAddress')
    }

    const tokenList = Object.values(tokensByChain).flat()
    if (!tokenList.length) {
      throw new Error('SDK Validation: Empty token list passed')
    }

    if (tokenList.filter((token) => !isToken(token)).length) {
      throw new Error('SDK Validation: Invalid token passed')
    }

    return balances.getTokenBalancesForChains(walletAddress, tokensByChain)
  }
}

export default new LIFI()