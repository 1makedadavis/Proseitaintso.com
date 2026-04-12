const https = require('https');

exports.handler = async (event) => {
  exports.handler = async (event) => {
  console.log('API KEY:', process.env.ANTHROPIC_API_KEY ? 'EXISTS - length: ' + process.env.ANTHROPIC_API_KEY.length : 'MISSING');
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: data
      }));
    });

    req.on('error', () => resolve({
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Request failed' })
    }));

    req.write(event.body);
    req.end();
  });
};
