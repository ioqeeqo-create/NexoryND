/**
 * Консольная проверка шлюза без UI (стратегия «сначала данные»).
 *
 *   cd flow_fixed
 *   set FLOW_GATEWAY_URL=http://127.0.0.1:3950
 *   set FLOW_GATEWAY_SECRET=твой-секрет
 *   set FLOW_TEST_QUERY=test
 *   npm run test:gateway
 */

const { createFlowGatewayClient } = require('../packages/flow-api-client')

async function main() {
  const baseUrl = String(process.env.FLOW_GATEWAY_URL || '').trim()
  const secret = String(process.env.FLOW_GATEWAY_SECRET || '').trim()
  const q = String(process.env.FLOW_TEST_QUERY || 'daft punk').trim()

  if (!baseUrl || !secret) {
    console.error('Задай FLOW_GATEWAY_URL и FLOW_GATEWAY_SECRET')
    process.exit(1)
  }

  const client = createFlowGatewayClient({ baseUrl, secret })

  console.log('--- health ---')
  console.log(JSON.stringify(await client.health(), null, 2))

  console.log('\n--- search hybrid ---')
  const searchRes = await client.search(q, 'hybrid', {
    spotifyToken: process.env.FLOW_SPOTIFY_TOKEN || '',
    yandexToken: process.env.FLOW_YANDEX_TOKEN || '',
    vkToken: process.env.FLOW_VK_TOKEN || '',
    soundcloudClientId: process.env.FLOW_SC_CLIENT_ID || '',
  })
  console.log('ok:', searchRes.ok, 'count:', searchRes.tracks?.length, 'mode:', searchRes.mode)
  if (searchRes.error) console.log('error:', searchRes.error)
  if (searchRes.tracks?.[0]) {
    console.log('first:', JSON.stringify(searchRes.tracks[0], null, 2))
  }

  if (searchRes.tracks?.[0]) {
    console.log('\n--- resolve first ---')
    const r2 = await client.resolve(searchRes.tracks[0], {
      yandexToken: process.env.FLOW_YANDEX_TOKEN || '',
      vkToken: process.env.FLOW_VK_TOKEN || '',
      soundcloudClientId: process.env.FLOW_SC_CLIENT_ID || '',
    })
    console.log(JSON.stringify(r2, null, 2))
  }

  console.log('\n--- probe tokens (yandex/vk если заданы в env) ---')
  console.log(
    JSON.stringify(
      await client.probeSavedTokens({
        yandexToken: process.env.FLOW_YANDEX_TOKEN || '',
        vkToken: process.env.FLOW_VK_TOKEN || '',
      }),
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
