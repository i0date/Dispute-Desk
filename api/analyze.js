const https = require('https')

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' })
  }

  try {
    const payload = JSON.stringify(typeof req.body === 'string' ? JSON.parse(req.body) : req.body)

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }

    const apiReq = https.request(options, (apiRes) => {
      let data = ''
      apiRes.on('data', (chunk) => { data += chunk })
      apiRes.on('end', () => {
        try {
          res.status(apiRes.statusCode).json(JSON.parse(data))
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse Anthropic response' })
        }
      })
    })

    apiReq.on('error', (err) => {
      res.status(500).json({ error: err.message })
    })

    apiReq.write(payload)
    apiReq.end()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
