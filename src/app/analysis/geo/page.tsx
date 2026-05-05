// /analysis/geo — moved to canonical /analysis/cut/geo_binary.
import { redirect } from "next/navigation";

export default function GeoRedirect() {
  redirect("/analysis/cut/geo_binary");
}
