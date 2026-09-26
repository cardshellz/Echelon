/** Exact portal ownership projection for the existing receiving/admin search.
 * A repacked parcel can span multiple child cases, so its tracking locates every
 * case under that RMA. Quantities are still received against exact case items.
 */
export const CUSTOMER_RETURN_LABEL_SEARCH_SQL = `
SELECT a.authorization_number,
  (SELECT STRING_AGG(t.result_snapshot->>'trackingNumber', ' ' ORDER BY p.id)
   FROM returns.customer_return_parcels p
   JOIN returns.customer_return_label_attempts t ON t.parcel_id = p.id AND t.status = 'succeeded'
   WHERE p.authorization_id = a.id) AS tracking_numbers
FROM returns.customer_return_case_links link
JOIN returns.customer_return_authorizations a ON a.id = link.authorization_id
WHERE link.case_id = rc.id
`;
