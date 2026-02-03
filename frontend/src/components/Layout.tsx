import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="bg-white border-b border-gray-100">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            {/* Spill logo - teal drop with smile */}
            <svg width="28" height="28" viewBox="0 0 100 110" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M75 8 Q85 5 82 18 Q95 50 80 80 Q65 105 40 105 Q10 105 5 70 Q0 40 30 25 Q50 15 60 5 Q68 -2 75 8Z" fill="#2DD4BF"/>
              <path d="M22 68 Q32 82 48 80" stroke="white" strokeWidth="7" strokeLinecap="round" fill="none"/>
            </svg>
            <span className="text-xl font-extrabold text-slate-900">spill</span>
          </Link>
          <nav className="flex items-center gap-6">
            <a
              href="https://spill.chat"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors"
            >
              About us
            </a>
            <a
              href="mailto:support@spill.chat"
              className="text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors"
            >
              Need help?
            </a>
          </nav>
        </div>
      </header>
      <main className="flex-1 mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 w-full">
        {children}
      </main>
      <footer className="bg-slate-50 border-t border-gray-100">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-slate-500">
            Spill
          </p>
        </div>
      </footer>
    </div>
  );
}
