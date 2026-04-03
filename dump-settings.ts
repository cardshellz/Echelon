import "dotenv/config";
async function run() {
  const url = "http://localhost:5000/api/storefront/member-pricing?variant_ids=46869766963423";
  // Wait, I am running local node script so I should invoke the function directly or fetch from heroku
  const res = await fetch("https://shellz-club-app-c299723495c9.herokuapp.com/api/storefront/member-pricing?variant_ids=46869766963423");
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}
run();
