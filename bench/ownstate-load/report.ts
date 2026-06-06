/**
 * Minimal assertion + reporting collector for the load harness. Unlike a test
 * runner, a `check` does not throw — the harness keeps going so one failure
 * doesn't hide the rest, and the run ends with a single structured summary +
 * a process exit code. `finding()` is distinct from a failed `check`: it records
 * a REAL server defect the harness surfaced (a leaked slot, an unclean shutdown,
 * a dropped/duplicated event), which is the whole point of the run.
 */

type Status = 'pass' | 'fail' | 'skip';

interface Check {
  status: Status;
  name: string;
  detail: string | undefined;
}

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

export class Report {
  private readonly checks: Check[] = [];
  readonly findings: Finding[] = [];

  check(name: string, condition: boolean, detail?: string): boolean {
    this.checks.push({ status: condition ? 'pass' : 'fail', name, detail });
    const tag = condition ? '  ok' : 'FAIL';
    console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
    return condition;
  }

  skip(name: string, reason: string): void {
    this.checks.push({ status: 'skip', name, detail: reason });
    console.log(`  [skip] ${name}  — ${reason}`);
  }

  info(msg: string): void {
    console.log(`  ·     ${msg}`);
  }

  section(title: string): void {
    console.log(`\n=== ${title} ===`);
  }

  /** Record a real server defect the harness surfaced. */
  finding(f: Finding): void {
    this.findings.push(f);
    console.log(`  [FINDING:${f.severity}] ${f.title} — ${f.detail}`);
  }

  /** Print the summary and return true iff the run is a pass (no fails, no findings). */
  finish(): boolean {
    const pass = this.checks.filter((c) => c.status === 'pass').length;
    const fail = this.checks.filter((c) => c.status === 'fail').length;
    const skip = this.checks.filter((c) => c.status === 'skip').length;
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`Checks: ${pass} passed, ${fail} failed, ${skip} skipped`);
    if (this.findings.length > 0) {
      console.log(`\nFINDINGS (${this.findings.length}) — real server defects surfaced by the harness:`);
      for (const f of this.findings) console.log(`  • [${f.severity}] ${f.title}\n      ${f.detail}`);
    } else {
      console.log(`Findings: none — no leaked slot, unclean shutdown, or dropped/duplicated event surfaced.`);
    }
    if (fail > 0) {
      console.log(`\nFAILED CHECKS:`);
      for (const c of this.checks.filter((c) => c.status === 'fail')) {
        console.log(`  ✗ ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
      }
    }
    const ok = fail === 0 && this.findings.length === 0;
    console.log(`\nRESULT: ${ok ? 'PASS' : 'ATTENTION'} ${'─'.repeat(20)}\n`);
    return ok;
  }
}
