import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { previewTherapistCV, createTherapistFromCV } from '../api/client';
import type { ExtractedTherapistProfile, AdminNotes } from '../types';

// Toast notification component for file validation errors
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed bottom-4 right-4 bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 z-50 animate-fade-in">
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <span>{message}</span>
      <button onClick={onClose} className="ml-2 hover:opacity-75" aria-label="Dismiss">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Confirmation modal component
function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  isLoading,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
        <p className="text-slate-600 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 bg-teal-500 text-white rounded-lg hover:bg-teal-600 transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Creating...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminIngestionPage() {
  const [therapistName, setTherapistName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [previewData, setPreviewData] = useState<ExtractedTherapistProfile | null>(null);

  // Override fields
  const [overrideEmail, setOverrideEmail] = useState('');
  const [overrideSpecialisms, setOverrideSpecialisms] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Success state
  const [createdTherapist, setCreatedTherapist] = useState<{ id: string; url: string } | null>(null);

  // UI state for modals/toasts
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('No file selected');
      if (!therapistName.trim()) throw new Error('Please enter the therapist name');
      // Prepend the name to additional info so AI knows the correct name
      const fullAdditionalInfo = `Therapist Name: ${therapistName.trim()}\n\n${additionalInfo}`;
      return previewTherapistCV(file, fullAdditionalInfo);
    },
    onSuccess: (data) => {
      setPreviewData(data.extractedProfile);
      // Pre-fill override fields with extracted values
      setOverrideEmail(data.extractedProfile.email || '');
      setOverrideSpecialisms(data.extractedProfile.specialisms?.join(', ') || '');
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('No file selected');
      if (!therapistName.trim()) throw new Error('Please enter the therapist name');

      // Prepend the name to additional info
      const fullAdditionalInfo = `Therapist Name: ${therapistName.trim()}\n\n${additionalInfo}`;

      const adminNotes: AdminNotes = {
        additionalInfo: fullAdditionalInfo || undefined,
        overrideEmail: overrideEmail || undefined,
        overrideSpecialisms: overrideSpecialisms
          ? overrideSpecialisms.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        notes: internalNotes || undefined,
      };

      return createTherapistFromCV(file, adminNotes);
    },
    onSuccess: (data) => {
      setCreatedTherapist({ id: data.therapistId, url: data.notionUrl });
      // Reset form
      setTherapistName('');
      setFile(null);
      setAdditionalInfo('');
      setPreviewData(null);
      setOverrideEmail('');
      setOverrideSpecialisms('');
      setInternalNotes('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.type !== 'application/pdf') {
        setToastMessage('Please select a PDF file');
        // Clear the input so user can select again
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }
      if (selectedFile.size > 10 * 1024 * 1024) {
        setToastMessage('File too large. Maximum size is 10MB.');
        // Clear the input so user can select again
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }
      setFile(selectedFile);
      setPreviewData(null);
      setCreatedTherapist(null);
    }
  };

  const handlePreview = (e: React.FormEvent) => {
    e.preventDefault();
    previewMutation.mutate();
  };

  const handleCreate = () => {
    setShowConfirmModal(true);
  };

  const handleConfirmCreate = () => {
    setShowConfirmModal(false);
    createMutation.mutate();
  };

  const handleReset = () => {
    setTherapistName('');
    setFile(null);
    setAdditionalInfo('');
    setPreviewData(null);
    setOverrideEmail('');
    setOverrideSpecialisms('');
    setInternalNotes('');
    setCreatedTherapist(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Therapist Ingestion</h1>
          <p className="text-slate-600 mt-1">Upload CV and additional information to create therapist profiles</p>
        </div>

        {/* Success Banner */}
        {createdTherapist && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-green-800">Therapist Created Successfully!</h3>
                <p className="text-sm text-green-700 mt-1">
                  <a
                    href={createdTherapist.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:no-underline"
                  >
                    View in Notion
                  </a>
                </p>
              </div>
              <button onClick={() => setCreatedTherapist(null)} className="text-green-600 hover:text-green-800">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Main Form */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
          <form onSubmit={handlePreview} className="space-y-6">
            {/* Therapist Name */}
            <div>
              <label htmlFor="therapistName" className="block text-sm font-medium text-slate-700 mb-2">
                Therapist Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="therapistName"
                value={therapistName}
                onChange={(e) => setTherapistName(e.target.value)}
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none"
                placeholder="Enter the therapist's full name"
                required
              />
            </div>

            {/* PDF Upload */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Therapist CV / Application (PDF)
              </label>
              <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center hover:border-teal-300 transition-colors">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={handleFileChange}
                  className="hidden"
                  id="pdfUpload"
                />
                <label htmlFor="pdfUpload" className="cursor-pointer">
                  {file ? (
                    <div className="flex items-center justify-center gap-3">
                      <svg className="w-8 h-8 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <div className="text-left">
                        <p className="font-medium text-slate-900">{file.name}</p>
                        <p className="text-sm text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <svg
                        className="w-12 h-12 text-slate-300 mx-auto mb-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                      <p className="text-slate-600">Click to upload PDF</p>
                      <p className="text-sm text-slate-400 mt-1">Max 10MB</p>
                    </>
                  )}
                </label>
              </div>
            </div>

            {/* Additional Information */}
            <div>
              <label htmlFor="additionalInfo" className="block text-sm font-medium text-slate-700 mb-2">
                Additional Information (up to 2000 words)
              </label>
              <textarea
                id="additionalInfo"
                value={additionalInfo}
                onChange={(e) => setAdditionalInfo(e.target.value)}
                rows={8}
                maxLength={12000}
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none resize-y"
                placeholder="Enter any additional context about the therapist that isn't in the CV. This could include their preferred approach, specific populations they work with, additional qualifications, bio preferences, etc."
              />
              <p className="text-sm text-slate-500 mt-1">{additionalInfo.length.toLocaleString()} / 12,000 characters</p>
            </div>

            {/* Preview Button */}
            <button
              type="submit"
              disabled={!file || !therapistName.trim() || previewMutation.isPending}
              className="w-full py-3 px-4 bg-slate-800 text-white font-semibold rounded-full hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {previewMutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Extracting...
                </span>
              ) : (
                'Preview Extraction'
              )}
            </button>

            {previewMutation.isError && (
              <p className="text-red-600 text-sm text-center">
                {previewMutation.error instanceof Error ? previewMutation.error.message : 'Failed to preview'}
              </p>
            )}
          </form>
        </div>

        {/* Preview Results */}
        {previewData && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Extracted Profile</h2>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-slate-500 mb-1">Name</label>
                <p className="text-lg font-semibold text-slate-900">{previewData.name}</p>
              </div>

              {/* Email Override */}
              <div>
                <label htmlFor="overrideEmail" className="block text-sm font-medium text-slate-500 mb-1">
                  Email (editable)
                </label>
                <input
                  type="email"
                  id="overrideEmail"
                  value={overrideEmail}
                  onChange={(e) => setOverrideEmail(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none"
                />
              </div>

              {/* Bio */}
              <div>
                <label className="block text-sm font-medium text-slate-500 mb-1">Generated Bio</label>
                <div className="bg-slate-50 rounded-lg p-4">
                  <p className="text-slate-700 whitespace-pre-wrap">{previewData.bio}</p>
                </div>
              </div>

              {/* Specialisms Override */}
              <div>
                <label htmlFor="overrideSpecialisms" className="block text-sm font-medium text-slate-500 mb-1">
                  Specialisms (comma-separated, editable)
                </label>
                <input
                  type="text"
                  id="overrideSpecialisms"
                  value={overrideSpecialisms}
                  onChange={(e) => setOverrideSpecialisms(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none"
                  placeholder="e.g., Anxiety, Depression, CBT, EMDR"
                />
                <div className="flex flex-wrap gap-2 mt-2">
                  {overrideSpecialisms
                    .split(',')
                    .filter((s) => s.trim())
                    .map((s, i) => (
                      <span key={i} className="px-2 py-1 bg-teal-50 text-teal-700 text-sm rounded-full">
                        {s.trim()}
                      </span>
                    ))}
                </div>
              </div>

              {/* Qualifications */}
              {previewData.qualifications && previewData.qualifications.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-500 mb-1">Qualifications</label>
                  <ul className="list-disc list-inside text-slate-700">
                    {previewData.qualifications.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Years Experience */}
              {previewData.yearsExperience && (
                <div>
                  <label className="block text-sm font-medium text-slate-500 mb-1">Years of Experience</label>
                  <p className="text-slate-700">{previewData.yearsExperience} years</p>
                </div>
              )}

              {/* Internal Notes */}
              <div>
                <label htmlFor="internalNotes" className="block text-sm font-medium text-slate-500 mb-1">
                  Internal Notes (not visible to users)
                </label>
                <textarea
                  id="internalNotes"
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none resize-y"
                  placeholder="Any internal notes about this therapist..."
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-4 mt-6">
              <button
                onClick={handleCreate}
                disabled={createMutation.isPending}
                className="flex-1 py-3 px-4 bg-teal-500 text-white font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {createMutation.isPending ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                        fill="none"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Creating...
                  </span>
                ) : (
                  'Create Therapist'
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={createMutation.isPending}
                className="py-3 px-6 border border-slate-200 text-slate-700 font-semibold rounded-full hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                Start Over
              </button>
            </div>

            {createMutation.isError && (
              <p className="text-red-600 text-sm text-center mt-4">
                {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create therapist'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Toast notification for file validation errors */}
      {toastMessage && (
        <Toast
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Confirmation modal for creating therapist */}
      {showConfirmModal && (
        <ConfirmModal
          title="Create Therapist"
          message="This will add the therapist to the Notion database. Are you sure you want to proceed?"
          onConfirm={handleConfirmCreate}
          onCancel={() => setShowConfirmModal(false)}
          isLoading={createMutation.isPending}
        />
      )}
    </div>
  );
}
