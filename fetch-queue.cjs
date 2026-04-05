(async function() {
  try {
    const r = await fetch("https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/picking/queue/single", {
      headers: { "x-device-type": "scanner" }
    });
    const data = await r.json();
    console.log("Queue size:", Array.isArray(data) ? data.length : "Not an array");
    
    if (Array.isArray(data) && data.length > 0) {
      // Find orders 55566 and 55554
      const newOrders = data.filter(d => ['55566', '55554'].includes(d.orderNumber) || d.id > 90000);
      console.log(`Found ${newOrders.length} recent orders.`);
      if (newOrders.length > 0) {
        console.log("First new order id:", newOrders[0].id, "num:", newOrders[0].orderNumber);
      }
      
      // Find an order to check images
      const sample = data.find(d => d.items && d.items.length > 0);
      if (sample) {
        console.log("Sample item image URL for", sample.items[0].sku, ":", sample.items[0].imageUrl);
      }
    } else {
      console.log(data);
    }
  } catch(e) {
    console.error(e.message);
  }
})();
