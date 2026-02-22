import { lazy, Suspense } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import TherapistsPage from './pages/TherapistsPage';
import TherapistDetailPage from './pages/TherapistDetailPage';
import FeedbackFormPage from './pages/FeedbackFormPage';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import ErrorBoundary from './components/ErrorBoundary';

// Lazy-load admin pages to reduce initial bundle size for public users
const AdminHomePage = lazy(() => import('./pages/AdminHomePage'));
const AdminIngestionPage = lazy(() => import('./pages/AdminIngestionPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const AdminKnowledgePage = lazy(() => import('./pages/AdminKnowledgePage'));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage'));
const AdminFormsPage = lazy(() => import('./pages/AdminFormsPage'));
const AdminAppointmentsPage = lazy(() => import('./pages/AdminAppointmentsPage'));

function AdminLoadingFallback() {
  return (
    <div className="flex items-center justify-center p-12">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800"></div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        {/* Public routes with standard layout */}
        <Route
          path="/"
          element={
            <Layout>
              <TherapistsPage />
            </Layout>
          }
        />
        <Route
          path="/therapist/:id"
          element={
            <Layout>
              <TherapistDetailPage />
            </Layout>
          }
        />
        {/* Feedback form has its own full-page layout */}
        <Route path="/feedback" element={<FeedbackFormPage />} />
        <Route path="/feedback/:splCode" element={<FeedbackFormPage />} />

        {/* Admin routes with sidebar layout - lazy loaded */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Suspense fallback={<AdminLoadingFallback />}><AdminHomePage /></Suspense>} />
          <Route path="dashboard" element={<Suspense fallback={<AdminLoadingFallback />}><AdminDashboardPage /></Suspense>} />
          <Route path="appointments" element={<Suspense fallback={<AdminLoadingFallback />}><AdminAppointmentsPage /></Suspense>} />
          <Route path="ingestion" element={<Suspense fallback={<AdminLoadingFallback />}><AdminIngestionPage /></Suspense>} />
          <Route path="knowledge" element={<Suspense fallback={<AdminLoadingFallback />}><AdminKnowledgePage /></Suspense>} />
          <Route path="forms" element={<Suspense fallback={<AdminLoadingFallback />}><AdminFormsPage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<AdminLoadingFallback />}><AdminSettingsPage /></Suspense>} />
        </Route>

        {/* 404 catch-all route */}
        <Route
          path="*"
          element={
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                <h1 className="text-4xl font-bold text-gray-900 mb-2">404</h1>
                <p className="text-gray-600 mb-6">Page not found</p>
                <Link
                  to="/"
                  className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
                >
                  Go back home
                </Link>
              </div>
            </div>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
