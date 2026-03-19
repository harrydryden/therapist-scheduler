interface PaginationProps {
  page: number;
  totalPages: number;
  total?: number;
  limit?: number;
  onPageChange: (page: number) => void;
}

export default function Pagination({ page, totalPages, total, limit, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between">
      <span className="text-xs text-slate-400">
        {total != null && limit != null
          ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}`
          : `Page ${page} of ${totalPages}`}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous page"
          className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        {totalPages <= 5 ? (
          Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
            <button
              key={pageNum}
              onClick={() => onPageChange(pageNum)}
              className={`px-2.5 py-1 text-xs border rounded ${
                pageNum === page
                  ? 'bg-spill-blue-800 text-white border-spill-blue-800'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              {pageNum}
            </button>
          ))
        ) : (
          Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            const startPage = Math.max(1, Math.min(page - 2, totalPages - 4));
            const pageNum = startPage + i;
            if (pageNum > totalPages) return null;
            return (
              <button
                key={pageNum}
                onClick={() => onPageChange(pageNum)}
                className={`px-2.5 py-1 text-xs border rounded ${
                  pageNum === page
                    ? 'bg-spill-blue-800 text-white border-spill-blue-800'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                {pageNum}
              </button>
            );
          })
        )}
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
