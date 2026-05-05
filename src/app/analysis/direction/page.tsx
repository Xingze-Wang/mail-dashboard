// /analysis/direction — moved to canonical /analysis/cut/direction.
import { redirect } from "next/navigation";

export default function DirectionRedirect() {
  redirect("/analysis/cut/direction");
}
