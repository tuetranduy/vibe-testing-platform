import { redirect } from "next/navigation";

// The run history becomes the home page with Task 20 (Ruling R52).
export default function HomePage() {
  redirect("/runs/new");
}
