import { Link } from 'react-router-dom';

interface AdminCard {
  name: string;
  path: string;
  icon: string;
  description: string;
  preview: string;
  color: string;
}

const adminPages: AdminCard[] = [
  {
    name: 'Dashboard',
    path: '/admin/dashboard',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    description: 'View and manage appointments',
    preview: 'Monitor appointment requests, track booking progress, and manage therapist availability. See real-time status of all active bookings.',
    color: 'bg-blue-500',
  },
  {
    name: 'Ingestion',
    path: '/admin/ingestion',
    icon: 'M12 4v16m8-8H4',
    description: 'Add new therapists',
    preview: 'Upload therapist profiles from Notion. Import availability, specializations, and contact information for new therapists.',
    color: 'bg-green-500',
  },
  {
    name: 'Knowledge Base',
    path: '/admin/knowledge',
    icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    description: 'Manage AI knowledge',
    preview: 'Configure the AI assistant\'s knowledge base. Add FAQs, booking rules, and customize responses for common scenarios.',
    color: 'bg-purple-500',
  },
  {
    name: 'Forms',
    path: '/admin/forms',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    description: 'Feedback form settings',
    preview: 'Customize feedback forms sent to clients after sessions. Configure questions, scoring criteria, and notification settings.',
    color: 'bg-amber-500',
  },
  {
    name: 'Settings',
    path: '/admin/settings',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    description: 'System configuration',
    preview: 'Configure email templates, notification preferences, AI behavior, and integration settings for the scheduling system.',
    color: 'bg-slate-500',
  },
];

export default function AdminHomePage() {
  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Admin Panel</h1>
        <p className="mt-1 text-slate-500">
          Manage your therapist scheduling system
        </p>
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {adminPages.map((page) => (
          <Link
            key={page.path}
            to={page.path}
            className="group bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-lg hover:border-slate-300 transition-all duration-200"
          >
            {/* Card Header with Icon */}
            <div className={`${page.color} p-4`}>
              <div className="w-12 h-12 bg-white/20 rounded-lg flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={page.icon}
                  />
                </svg>
              </div>
            </div>

            {/* Card Content */}
            <div className="p-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold text-slate-900 group-hover:text-spill-blue-600 transition-colors">
                  {page.name}
                </h2>
                <svg
                  className="w-5 h-5 text-slate-400 group-hover:text-spill-blue-500 group-hover:translate-x-1 transition-all"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
              <p className="text-sm text-slate-500 mb-3">{page.description}</p>
              <p className="text-sm text-slate-600 leading-relaxed">
                {page.preview}
              </p>
            </div>
          </Link>
        ))}
      </div>

      {/* Quick Links */}
      <div className="mt-10 pt-8 border-t border-slate-200">
        <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wider mb-4">
          Quick Links
        </h3>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            View Booking Site
          </Link>
          <a
            href="https://notion.so"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
            Open Notion
          </a>
        </div>
      </div>
    </div>
  );
}
