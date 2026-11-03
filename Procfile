release: bash scripts/release.sh
web: bash scripts/start-web.sh
recommendations: npm run procurement:snapshot-recommendations
forecast-evaluations: npm run procurement:evaluate-forecasts
inventory-capture: node --max-old-space-size=384 dist/inventory-opening-capture.cjs
