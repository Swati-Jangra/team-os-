'use client';
import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Code, Heading2, Italic, Link as LinkIcon, List, ListOrdered, Quote, Redo2, Undo2 } from 'lucide-react';
import { cn } from '@teamos/ui';

interface Props {
  value: string;
  onChange?: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
  /** change to force the editor to load `value` (e.g. after restore / reload); typing never triggers it */
  resetKey?: string | number;
  label: string;
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn('rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', active && 'bg-primary-soft text-primary')}
    >
      {children}
    </button>
  );
}

/** Tiptap rich-text editor. Output is plain HTML; the API sanitises it again on save, so nothing here is trusted. */
export function RichEditor({ value, onChange, editable = true, placeholder, resetKey, label }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }), // Tiptap 3's StarterKit bundles Link; we configure our own below
      Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
    ],
    content: value,
    editorProps: { attributes: { class: 'rich-content focus:outline-none', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor: e }) => onChange?.(e.isEmpty ? '' : e.getHTML()),
  });

  useEffect(() => {
    if (editor && editor.getHTML() !== value && !(editor.isEmpty && value === '')) editor.commands.setContent(value, { emitUpdate: false });
    // only when the caller asks for a reload — not on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, editor]);
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  if (!editor) return <div className="h-64 animate-pulse rounded-xl bg-muted" />;

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (https://…)', prev ?? 'https://');
    if (url === null) return;
    if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else if (/^(https?:|mailto:)/i.test(url)) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {editable ? (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 p-1.5">
          <Tool label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></Tool>
          <Tool label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></Tool>
          <Tool label="Heading" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></Tool>
          <Tool label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></Tool>
          <Tool label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></Tool>
          <Tool label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></Tool>
          <Tool label="Code" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code className="h-4 w-4" /></Tool>
          <Tool label="Link" active={editor.isActive('link')} onClick={setLink}><LinkIcon className="h-4 w-4" /></Tool>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <Tool label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-4 w-4" /></Tool>
          <Tool label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-4 w-4" /></Tool>
        </div>
      ) : null}
      <EditorContent editor={editor} className="min-h-[320px] p-5" />
    </div>
  );
}
