import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import SpillLogo from './SpillLogo';

interface LayoutProps {
  children: ReactNode;
}

// Note: pages provide their own `mx-auto max-w-7xl px-…` container so
// full-bleed bands (e.g. the directory hero) can span the viewport.
export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="bg-white border-b border-spill-grey-200 sticky top-0 z-50">
        <div className="mx-auto max-w-7xl px-4 py-3.5 sm:px-6 lg:px-8 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded">
            <SpillLogo className="w-4 h-[22px]" />
            <span className="font-display font-bold text-xl tracking-[-0.4px]">Spill</span>
          </Link>
          <nav aria-label="Main navigation" className="flex items-center gap-6">
            <a
              href="https://spill.chat"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-spill-grey-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
            >
              About us
            </a>
            <a
              href="mailto:support@spill.chat"
              className="text-sm font-medium text-spill-grey-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
            >
              Need help?
            </a>
          </nav>
        </div>
      </header>
      <main className="flex-1 w-full">
        {children}
      </main>
      <footer className="bg-spill-grey-100 border-t border-spill-grey-200">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 flex items-center justify-center gap-2 text-spill-grey-400">
          <SpillLogo className="w-2.5 h-3.5" />
          <span className="text-sm">Spill</span>
        </div>
      </footer>
    </div>
  );
}
