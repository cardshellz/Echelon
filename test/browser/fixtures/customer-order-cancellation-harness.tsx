import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomerOrderCancellation } from "../../../client/src/customer-account/CustomerOrderCancellation";
import { createCustomerAccountTransport } from "../../../client/src/customer-account/customer-account.transport";
import "../../../client/src/customer-account/storefront.css";

const api = createCustomerAccountTransport({
  themeId: "174740308127",
  customerId: "100",
  proxyPath: "/apps/echelon-returns",
});
function Harness() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.bootstrap(controller.signal).then(
      () => {
        if (!controller.signal.aborted) setReady(true);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, []);
  if (failed) return <p role="alert">Fixture bootstrap failed.</p>;
  if (!ready) return <p>Loading fixture…</p>;
  if (closed) return <h1>Order options closed</h1>;
  return (
    <main className="csz-account-ui">
      <button type="button" onClick={() => setClosed(true)}>
        Close cancellation
      </button>
      <CustomerOrderCancellation
        api={api}
        scope={{ customerId: "100", connectionId: 4, omsOrderId: 1 }}
        existingRequestKey={null}
        onBack={() => setClosed(true)}
        onDone={() => setClosed(true)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
