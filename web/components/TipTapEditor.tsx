'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Button, Space, Tooltip, Divider } from 'antd';
import {
  BoldOutlined, ItalicOutlined, StrikethroughOutlined,
  OrderedListOutlined, UnorderedListOutlined,
  PictureOutlined, LinkOutlined, TableOutlined,
  UndoOutlined, RedoOutlined,
} from '@ant-design/icons';

interface TipTapEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

export default function TipTapEditor({ content, onChange, placeholder = '开始编写文章内容...' }: TipTapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }),
      Image,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  if (!editor) return null;

  const addLink = () => {
    const url = window.prompt('输入链接URL');
    if (url) editor.chain().focus().setLink({ href: url }).run();
  };

  const addImage = () => {
    const url = window.prompt('输入图片URL');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? '#e6f4ff' : 'transparent',
    border: active ? '1px solid #1677ff' : '1px solid transparent',
  });

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 6 }}>
      <div style={{ padding: '8px', borderBottom: '1px solid #d9d9d9', background: '#fafafa', position: 'sticky', top: 0, zIndex: 10 }}>
        <Space wrap size={[4, 4]}>
          <Tooltip title="加粗">
            <Button size="small" type="text" icon={<BoldOutlined />} style={btnStyle(editor.isActive('bold'))}
              onClick={() => editor.chain().focus().toggleBold().run()} />
          </Tooltip>
          <Tooltip title="斜体">
            <Button size="small" type="text" icon={<ItalicOutlined />} style={btnStyle(editor.isActive('italic'))}
              onClick={() => editor.chain().focus().toggleItalic().run()} />
          </Tooltip>
          <Tooltip title="删除线">
            <Button size="small" type="text" icon={<StrikethroughOutlined />} style={btnStyle(editor.isActive('strike'))}
              onClick={() => editor.chain().focus().toggleStrike().run()} />
          </Tooltip>
          <Divider type="vertical" />
          <Tooltip title="H1">
            <Button size="small" type="text" style={btnStyle(editor.isActive('heading', { level: 1 }))}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</Button>
          </Tooltip>
          <Tooltip title="H2">
            <Button size="small" type="text" style={btnStyle(editor.isActive('heading', { level: 2 }))}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Button>
          </Tooltip>
          <Tooltip title="H3">
            <Button size="small" type="text" style={btnStyle(editor.isActive('heading', { level: 3 }))}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Button>
          </Tooltip>
          <Divider type="vertical" />
          <Tooltip title="无序列表">
            <Button size="small" type="text" icon={<UnorderedListOutlined />} style={btnStyle(editor.isActive('bulletList'))}
              onClick={() => editor.chain().focus().toggleBulletList().run()} />
          </Tooltip>
          <Tooltip title="有序列表">
            <Button size="small" type="text" icon={<OrderedListOutlined />} style={btnStyle(editor.isActive('orderedList'))}
              onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          </Tooltip>
          <Tooltip title="引用">
            <Button size="small" type="text" style={btnStyle(editor.isActive('blockquote'))}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}>引用</Button>
          </Tooltip>
          <Divider type="vertical" />
          <Tooltip title="插入表格">
            <Button size="small" type="text" icon={<TableOutlined />}
              onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
          </Tooltip>
          <Tooltip title="插入图片">
            <Button size="small" type="text" icon={<PictureOutlined />} onClick={addImage} />
          </Tooltip>
          <Tooltip title="插入链接">
            <Button size="small" type="text" icon={<LinkOutlined />} onClick={addLink} />
          </Tooltip>
          <Divider type="vertical" />
          <Tooltip title="撤销">
            <Button size="small" type="text" icon={<UndoOutlined />} disabled={!editor.can().undo()}
              onClick={() => editor.chain().focus().undo().run()} />
          </Tooltip>
          <Tooltip title="重做">
            <Button size="small" type="text" icon={<RedoOutlined />} disabled={!editor.can().redo()}
              onClick={() => editor.chain().focus().redo().run()} />
          </Tooltip>
        </Space>
      </div>
      <div style={{ padding: '16px', minHeight: 400 }} className="tiptap-content">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
