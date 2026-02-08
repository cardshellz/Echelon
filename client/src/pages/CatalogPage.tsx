import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Products from "./Products";
import Variants from "./Variants";

export default function CatalogPage() {
  const [location, navigate] = useLocation();

  const activeTab = location.startsWith("/catalog/variants") ? "variants" : "products";

  const handleTabChange = (tab: string) => {
    if (tab === "products") navigate("/catalog");
    else navigate("/catalog/variants");
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="border-b px-4 pt-1 bg-card shrink-0">
        <TabsList className="bg-transparent">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="variants">Variants</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="products" className="mt-0 flex-1 overflow-auto">
        <Products />
      </TabsContent>
      <TabsContent value="variants" className="mt-0 flex-1 overflow-auto">
        <Variants />
      </TabsContent>
    </Tabs>
  );
}
