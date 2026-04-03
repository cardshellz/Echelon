const fs = require('fs');

let content = fs.readFileSync('client/src/pages/OrderHistory.tsx', 'utf8');

// Update getPriorityColor function
const oldPriorityColor = `function getPriorityColor(priority: string) {
  switch (priority) {
    case "rush":
      return "bg-red-100 text-red-800";
    case "high":
      return "bg-orange-100 text-orange-800";
    default:
      return "bg-gray-100 text-gray-600";
  }
}`;
const newPriorityColor = `function getPriorityColor(priority: number) {
  if (priority >= 9999) return "bg-red-500 text-white border-red-500";
  if (priority >= 300) return "bg-orange-500 text-white border-orange-500";
  if (priority < 0) return "bg-gray-500 text-white border-gray-500";
  return "bg-gray-100 text-gray-600 border-gray-200";
}`;
content = content.replace(oldPriorityColor, newPriorityColor);

// 1. Mobile card format
const oldCardBadge = `{order.priority !== "normal" && (
                              <Badge variant="outline" className={\`text-xs \${getPriorityColor(order.priority)}\`}>
                                {order.priority}
                              </Badge>
                            )}`;
const newCardBadge = `{order.priority !== 100 && (
                              <Badge variant="outline" className={\`text-xs \${getPriorityColor(order.priority)}\`}>
                                {order.priority >= 9999 ? 'BUMPED' : order.priority < 0 ? 'HELD' : order.priority >= 300 ? \`P\${order.priority}\` : order.priority}
                              </Badge>
                            )}`;
content = content.replace(oldCardBadge, newCardBadge);

// 2. Desktop table format
const oldTableBadge = `{order.priority !== "normal" && (
                            <Badge variant="outline" className={\`ml-2 text-xs \${getPriorityColor(order.priority)}\`}>
                              {order.priority}
                            </Badge>
                          )}`;
const newTableBadge = `{order.priority !== 100 && (
                            <Badge variant="outline" className={\`ml-2 text-xs \${getPriorityColor(order.priority)}\`}>
                              {order.priority >= 9999 ? 'BUMPED' : order.priority < 0 ? 'HELD' : order.priority >= 300 ? \`P\${order.priority}\` : order.priority}
                            </Badge>
                          )}`;
content = content.replace(oldTableBadge, newTableBadge);

// 3. Detail panel format
const oldDetailBadge = `{order.priority !== "normal" && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Priority</span>
                <Badge variant="outline" className={getPriorityColor(order.priority)}>
                  {order.priority}
                </Badge>
              </div>
            )}`;
const newDetailBadge = `{order.priority !== 100 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Priority</span>
                <Badge variant="outline" className={getPriorityColor(order.priority)}>
                  {order.priority >= 9999 ? 'BUMPED' : order.priority < 0 ? 'HELD' : order.priority >= 300 ? \`P\${order.priority}\` : order.priority}
                </Badge>
              </div>
            )}`;
content = content.replace(oldDetailBadge, newDetailBadge);

fs.writeFileSync('client/src/pages/OrderHistory.tsx', content, 'utf8');
console.log('OrderHistory.tsx cleaned up.');
