async function run() {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  const baseUrl = "https://ssapi.shipstation.com";

  if (!apiKey || !apiSecret) {
    console.error("Missing ShipStation credentials in .env");
    process.exit(1);
  }

  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  const payload = {
    orderId: 731033382,
    carrierCode: "usps",
    shipDate: new Date().toISOString().split('T')[0],
    trackingNumber: "9400150106151203103112",
    notifyCustomer: false,
    notifySalesChannel: false
  };

  console.log("Calling /orders/markasshipped with", payload);
  
  const response = await fetch(`${baseUrl}/orders/markasshipped`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${encodedAuth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("SS Error:", response.status, errorText);
  } else {
    const data = await response.json();
    console.log("Result:", data);
  }
  process.exit(0);
}
run().catch(console.error);
