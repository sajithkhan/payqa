import 'dotenv/config';

const auth = Buffer.from(
  `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
).toString('base64');

const res = await fetch(`${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});

const data = await res.json();

if (res.ok) {
  console.log('✅ PayPal connected! Token starts:', data.access_token.slice(0, 15));
} else {
  console.log('❌ Failed:', data);
}