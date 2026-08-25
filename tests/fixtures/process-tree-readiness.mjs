export function installReadiness(afterReady) {
  process.on('message', (message) => {
    if (message?.type !== 'request' || message.url !== 'dsh://app/api/host.describe') return
    const envelope = JSON.parse(message.body)
    process.send?.({
      type: 'response',
      id: message.id,
      status: 200,
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            version: 'test',
            cwd: process.cwd(),
            attachedSessions: 0,
            home: process.env.DSH_HOME,
            canOpenPath: false,
          },
        },
      }),
    }, () => { afterReady?.() })
  })
}
