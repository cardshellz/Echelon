(async function() {
  try {
    const r = await fetch("https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/picking/queue/single", {
      headers: { "x-device-type": "scanner" }
    });
    const txt = await r.text();
    console.log("Status:", r.status);
    console.log(txt.substring(0, 1000));
  } catch(e) {
    console.error(e.message);
  }
})();
