import type { CustomerOrderProgress } from "@shared/customer-account/order-progress";
import {
  refundActivityLabel,
  returnProgressLabel,
} from "./customer-order-progress-presentation";

export function CustomerOrderProgressSummary({
  financialStatus,
  deliveryLabel,
  progress,
}: {
  financialStatus: string;
  deliveryLabel: string;
  progress?: CustomerOrderProgress | null;
}) {
  const returned = returnProgressLabel(progress),
    refund = refundActivityLabel(financialStatus, progress);
  return (
    <dl className="csz-order-tracks">
      <div>
        <dt>Payment</dt>
        <dd>
          {financialStatus}
          {refund && <small>{refund}</small>}
        </dd>
      </div>
      <div>
        <dt>Delivery</dt>
        <dd>{progress?.delivery?.label ?? deliveryLabel}</dd>
      </div>
      {returned && (
        <div>
          <dt>Return</dt>
          <dd>{returned}</dd>
        </div>
      )}
    </dl>
  );
}

/** All facts were loaded with the account page. Opening this section performs
 * no carrier read, eligibility check, money calculation or command. */
export function CustomerOrderProgressDetails({
  progress,
}: {
  progress?: CustomerOrderProgress | null;
}) {
  if (progress === undefined) return null;
  if (progress === null)
    return (
      <p className="csz-panel-explanation">
        Delivery and return progress couldn’t be loaded. Refresh your order to
        try again.
      </p>
    );
  return (
    <div className="csz-progress-details">
      {progress.refunds.length > 0 && (
        <details>
          <summary>Refund details</summary>
          <section aria-label="Refund progress">
            <ul>
              {progress.refunds.map((refund) => (
                <li key={refund.key}>
                  <span>{refund.reference}</span>
                  <strong>{refund.status.label}</strong>
                </li>
              ))}
            </ul>
          </section>
        </details>
      )}
      {progress.packages.length > 0 && (
        <details>
          <summary>
            Delivery details ({progress.packages.length}{" "}
            {progress.packages.length === 1 ? "package" : "packages"})
          </summary>
          <section aria-label="Original delivery progress">
            <ul>
              {progress.packages.map((parcel, index) => (
                <li key={parcel.key}>
                  <span>
                    Package {index + 1}
                    {parcel.trackingNumber && (
                      <small>{parcel.trackingNumber}</small>
                    )}
                  </span>
                  <strong>{parcel.status.label}</strong>
                </li>
              ))}
            </ul>
          </section>
        </details>
      )}
      {progress.returns.length > 0 && (
        <details>
          <summary>
            Return details ({progress.returns.length}{" "}
            {progress.returns.length === 1 ? "return" : "returns"})
          </summary>
          <section aria-label="Return progress">
            {progress.returns.map((request) => (
              <article key={request.key}>
                <div className="csz-progress-return-heading">
                  <span>{request.reference}</span>
                  <strong>{request.status.label}</strong>
                </div>
                <p>
                  {request.receivedQuantity} of {request.quantity}{" "}
                  {request.quantity === 1 ? "item" : "items"} received
                </p>
                {request.parcels.length > 0 && (
                  <ul>
                    {request.parcels.map((parcel, index) => (
                      <li key={parcel.key}>
                        <span>
                          Return box {index + 1}
                          {parcel.trackingNumber && (
                            <small>{parcel.trackingNumber}</small>
                          )}
                        </span>
                        <strong>
                          {parcel.status.code === "unknown"
                            ? "Tracking not available yet"
                            : parcel.status.label}
                        </strong>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
        </details>
      )}
      {progress.unavailable.includes("delivery") && (
        <p className="csz-panel-explanation">
          Delivery tracking is temporarily unavailable.
        </p>
      )}
      {progress.unavailable.includes("returns") && (
        <p className="csz-panel-explanation">
          Return progress is temporarily unavailable.
        </p>
      )}
      {progress.unavailable.includes("refunds") && (
        <p className="csz-panel-explanation">
          Refund progress is temporarily unavailable.
        </p>
      )}
    </div>
  );
}
