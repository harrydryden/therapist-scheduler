/**
 * Admin Login Component
 *
 * Standalone login form for the admin panel. Extracted from AdminLayout
 * so it can be replaced by the parent ATS app's auth flow.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AdminLogin() {
  const { login } = useAuth();
  const [secretInput, setSecretInput] = useState('');

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Admin Login</h1>
        <p className="text-sm text-slate-500 mb-6">
          Enter the admin secret to access the admin panel.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (secretInput.trim()) {
              await login(secretInput.trim());
            }
          }}
        >
          <input
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="Admin secret"
            className="w-full px-4 py-3 border border-slate-200 rounded-lg mb-4 focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            autoFocus
          />
          <button
            type="submit"
            disabled={!secretInput.trim()}
            className="w-full px-4 py-3 bg-spill-blue-800 text-white rounded-lg font-medium hover:bg-spill-blue-900 disabled:opacity-50 transition-colors"
          >
            Enter
          </button>
        </form>
        <Link
          to="/"
          className="block mt-4 text-center text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          Back to booking site
        </Link>
      </div>
    </div>
  );
}
