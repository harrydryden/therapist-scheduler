import { Routes, Route, Link } from 'react-router-dom';
import TherapistsPage from './pages/TherapistsPage';
import TherapistDetailPage from './pages/TherapistDetailPage';
import AdminHomePage from './pages/AdminHomePage';
import AdminIngestionPage from './pages/AdminIngestionPage';
import AdminDashboardPage from './pages/AdminDashboardPage';
import AdminKnowledgePage from './pages/AdminKnowledgePage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import FeedbackFormPage from './pages/FeedbackFormPage';
import AdminFormsPage from './pages/AdminFormsPage';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import ErrorBoundary from './components/ErrorBoundary';

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

        {/* Admin routes with sidebar layout */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminHomePage />} />
          <Route path="dashboard" element={<AdminDashboardPage />} />
          <Route path="ingestion" element={<AdminIngestionPage />} />
          <Route path="knowledge" element={<AdminKnowledgePage />} />
          <Route path="forms" element={<AdminFormsPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>

        {/* FIX #33: 404 catch-all route */}
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
