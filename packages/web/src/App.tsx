import { useEffect } from 'react';
import { useRoute } from './lib/router';
import { useConfig } from './lib/hooks';
import { short } from './lib/format';
import { Landing } from './pages/Landing';
import { Sandbox } from './pages/Sandbox';
import { RuleTester } from './pages/RuleTester';
import { ReceiptPage } from './pages/Receipt';
import { SellerConsole } from './pages/SellerConsole';
import { GATEWAY } from './lib/api';

const NAV = [
  { path: '/', label: 'Overview' },
  { path: '/sandbox', label: 'Sandbox' },
  { path: '/rules', label: 'Rule tester' },
  { path: '/sellers', label: 'Seller console' },
];

const TITLES: Record<string, string> = {
  '/': 'Clause — refunds for machine payments',
  '/sandbox': 'Sandbox · Clause',
  '/rules': 'Rule tester · Clause',
  '/sellers': 'Seller console · Clause',
};

export function App() {
  const route = useRoute();
  const config = useConfig();
  const section = route.path.startsWith('/receipt/') ? '/receipt' : route.path;

  useEffect(() => {
    document.title = TITLES[section] ?? 'Receipt · Clause';
  }, [section]);

  let page;
  if (route.path === '/') page = <Landing />;
  else if (route.path === '/sandbox') page = <Sandbox />;
  else if (route.path === '/rules') page = <RuleTester params={route.params} />;
  else if (route.path === '/sellers') page = <SellerConsole />;
  else if (route.path.startsWith('/receipt/')) page = <ReceiptPage callId={route.path.slice('/receipt/'.length)} />;
  else
    page = (
      <div className="empty">
        <h1>Not found</h1>
        <p style={{ marginTop: 12 }}>
          <a href="#/">Back to overview</a>
        </p>
      </div>
    );

  const cfg = config.data;
  return (
    <>
      <a className="sr-only" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="shell">
          <a className="brand" href="#/" aria-label="Clause home">
            <span className="brand-mark" aria-hidden>§</span>
            CLAUSE
          </a>
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => (
              <a key={n.path} href={`#${n.path}`} aria-current={section === n.path ? 'page' : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          {cfg && (
            <span className={`mode-chip ${cfg.mode}`} title={cfg.verdictSource}>
              {cfg.mode === 'simulated' ? 'Simulated · no wallet' : `Chain ${cfg.chainId}`}
            </span>
          )}
        </div>
      </header>
      {config.error && (
        <div className="shell" style={{ marginTop: 16 }}>
          <div className="notice err">
            Can't reach the Clause gateway{GATEWAY ? ` at ${GATEWAY}` : ''}. Start it with <code>npm run dev</code>, then reload.
          </div>
        </div>
      )}
      <main id="main">
        <div className="shell">{page}</div>
      </main>
      <footer className="footer">
        <div className="shell spread">
          <span>
            Clause · a refund layer for x402 machine payments
            {cfg && (
              <>
                {' '}· escrow <span className="mono">{short(cfg.escrow)}</span> · gateway <span className="mono">{short(cfg.gatewayAddress)}</span>
              </>
            )}
          </span>
          <span>The contract routes on the chip's output; it holds no rules of its own.</span>
        </div>
      </footer>
    </>
  );
}
