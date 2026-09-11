release: bash scripts/release.sh
web: npm run start
recommendations: npm run procurement:snapshot-recommendations
forecast-evaluations: npm run procurement:evaluate-forecasts
inventory-capture: node --max-old-space-size=384 dist/inventory-opening-capture.cjs
