const fs = require('fs');

let content = fs.readFileSync('client/src/pages/Orders.tsx', 'utf8');

// 1. Remove from interfaces
content = content.replace(/  financialStatus: string \| null;\n  shopifyFulfillmentStatus: string \| null;\n/g, '');
content = content.replace(/  totalAmount: string \| null;\n/g, '');

// 2. Remove financialStatusColors mapping
content = content.replace(/const financialStatusColors: Record<string, string> = {[\s\S]*?};\n\n/g, '');

// 3. Remove financial status badge
const badgeBlock = `{order.financialStatus && (
              <Badge variant="outline" className={cn("text-xs", financialStatusColors[order.financialStatus] || "")}>
                {order.financialStatus.replace("_", " ")}
              </Badge>
            )}
            `;
content = content.replace(badgeBlock, '');

// 4. Remove totalAmount from state initialization
content = content.replace(/    totalAmount: "",\n/g, '');
content = content.replace(/        totalAmount: "",\n/g, '');

// 5. Remove totalAmount from newOrder rendering (Combinable orders view)
const groupAmountBlock = `{order.totalAmount && (
                <span className="text-muted-foreground font-normal">\${order.totalAmount}</span>
              )}
`;
content = content.replace(groupAmountBlock, '');

const groupAmountBadge = `{order.totalAmount && (
                                  <span className="text-sm font-medium">\${order.totalAmount}</span>
                                )}
                                `;
content = content.replace(groupAmountBadge, '');

// 6. Remove totalAmount input from order form
const amountInputBlock = `<div className="space-y-2">
                <Label htmlFor="totalAmount" className="text-sm">Total Amount</Label>
                <Input
                  id="totalAmount"
                  value={newOrder.totalAmount}
                  onChange={(e) => setNewOrder({ ...newOrder, totalAmount: e.target.value })}
                  placeholder="$99.99"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-total-amount"
                />
              </div>`;

content = content.replace(amountInputBlock, '');

// We need to rewrite the grid so it isn't broken.
// Let's replace the whole grid containing customer phone and totalAmount
const oldGrid = `<div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="customerPhone" className="text-sm">Phone</Label>
                <Input
                  id="customerPhone"
                  value={newOrder.customerPhone}
                  onChange={(e) => setNewOrder({ ...newOrder, customerPhone: e.target.value })}
                  placeholder="(555) 123-4567"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-customer-phone"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="totalAmount" className="text-sm">Total Amount</Label>
                <Input
                  id="totalAmount"
                  value={newOrder.totalAmount}
                  onChange={(e) => setNewOrder({ ...newOrder, totalAmount: e.target.value })}
                  placeholder="$99.99"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-total-amount"
                />
              </div>
            </div>`;

const newGrid = `<div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="customerPhone" className="text-sm">Phone</Label>
                <Input
                  id="customerPhone"
                  value={newOrder.customerPhone}
                  onChange={(e) => setNewOrder({ ...newOrder, customerPhone: e.target.value })}
                  placeholder="(555) 123-4567"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-customer-phone"
                />
              </div>
            </div>`;

content = content.replace(oldGrid, newGrid);

fs.writeFileSync('client/src/pages/Orders.tsx', content, 'utf8');
console.log('Orders.tsx cleaned up.');
