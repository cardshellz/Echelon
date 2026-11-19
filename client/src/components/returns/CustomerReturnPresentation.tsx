import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef } from "react";

// The native store already has navigation and a single page-level heading.
export const CustomerReturnPresentationContext = createContext<"branded" | "storefront">("branded");

export const CustomerReturnHeading = forwardRef<HTMLHeadingElement, ComponentPropsWithoutRef<"h1">>(
  function CustomerReturnHeading(props, ref) {
    const Tag = useContext(CustomerReturnPresentationContext) === "storefront" ? "h2" : "h1";
    return <Tag {...props} ref={ref} data-return-heading />;
  },
);
