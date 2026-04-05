import 'dotenv/config';
import { getShopifyConfig } from './server/modules/integrations/shopify.js';

const SHOPIFY_API_VERSION = "2024-10";

async function run() {
  const config = getShopifyConfig();
  const url = `https://${config.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const query = `
    query {
      subscriptionContract(id: "gid://shopify/SubscriptionContract/15819538591") {
        id
        status
        lines(first: 5) {
          edges {
            node {
              sellingPlanId
              sellingPlanName
              productId
            }
          }
        }
      }
    }
  `;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({ query }),
  });

  const json = await response.json();
  console.dir(json, {depth: null});
  process.exit(0);
}
run();
