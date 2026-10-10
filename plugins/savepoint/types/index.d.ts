export type SavepointWork = { inFlight: number; lastWorkAt: number }

declare module 'claude-code' {
  interface PluginState {
    savepoint: {
      stepDone: boolean
      work: SavepointWork
      isHidden: boolean
      isResetting: boolean
      archivePath: string
      litAt: number
    }
  }
}
