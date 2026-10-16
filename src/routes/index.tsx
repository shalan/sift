import { createFileRoute } from "@tanstack/react-router";
import { SiftBench } from "@/components/sift-bench";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <SiftBench />;
}
