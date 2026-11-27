// Web Worker for the plan and retirement pages: runs Monte Carlo off the main thread so sliders stay smooth.
// Bundled by Vite as a same-origin file (CSP: worker-src 'self').
import { runMonteCarlo, type McInputs, type McResult } from '../../lib/invest/montecarlo';
import { runRetirement, type RetireInputs, type RetireResult } from '../../lib/invest/withdrawal';

export type McRequest =
  | { id: number; kind: 'main'; inputs: McInputs }
  | { id: number; kind: 'batch'; list: McInputs[] }
  | { id: number; kind: 'retire'; inputs: RetireInputs };

export type McResponse =
  | { id: number; kind: 'main'; result: McResult }
  | { id: number; kind: 'batch'; results: { successRate: number; medianAtRetirement: number }[] }
  | { id: number; kind: 'retire'; result: RetireResult }
  | { id: number; kind: 'error'; message: string };

const post = (msg: McResponse) => (self as unknown as Worker).postMessage(msg);

self.addEventListener('message', (e: MessageEvent<McRequest>) => {
  const req = e.data;
  try {
    if (req.kind === 'main') post({ id: req.id, kind: 'main', result: runMonteCarlo(req.inputs) });
    else if (req.kind === 'retire') post({ id: req.id, kind: 'retire', result: runRetirement(req.inputs) });
    else post({
      id: req.id, kind: 'batch',
      results: req.list.map(inp => {
        const r = runMonteCarlo(inp);
        return { successRate: r.successRate, medianAtRetirement: r.medianAtRetirement };
      }),
    });
  } catch (err) {
    post({ id: req.id, kind: 'error', message: (err as Error).message });
  }
});
