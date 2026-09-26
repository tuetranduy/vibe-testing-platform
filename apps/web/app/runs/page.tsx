import type { Metadata } from "next";
import { RunHistory } from "../../components/RunHistory";

export const metadata: Metadata = { title: "Test runs" };

export default function RunsPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div className="section-head">
          <h1>Test runs</h1>
          <p className="muted">Every test run, newest first. Open one to see its report.</p>
        </div>
        <a className="button button-primary" href="/runs/new">
          New test
        </a>
      </div>
      <RunHistory />
    </div>
  );
}
