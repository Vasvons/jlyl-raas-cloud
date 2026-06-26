'use client';

import { useEffect, useState } from 'react';
import { Card, Row, Col, Input, Button, Tag, InputNumber, message, Spin, Statistic, Space } from 'antd';
import { ArrowLeftOutlined, SaveOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import TipTapEditor from '@/components/TipTapEditor';

export default function ArticleEditPage({ params }: { params: { id: string } }) {
  const articleId = Number(params.id);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [contentHtml, setContentHtml] = useState('');
  const [coreKeyword, setCoreKeyword] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    api.get(`/content/articles/${articleId}`).then(res => {
      if (res.data?.code === 200) {
        const d = res.data.data;
        setTitle(d.title);
        setContentHtml(d.content_html);
        setCoreKeyword(d.core_keyword);
        setWordCount(d.word_count || 0);
        setTags(d.tags || []);
      }
    }).finally(() => setLoading(false));
  }, [articleId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/content/articles/${articleId}`, {
        title,
        content_html: contentHtml,
        tags,
        status: 'editing',
      });
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  const handleAddTag = () => {
    if (tagInput && !tags.includes(tagInput)) {
      setTags([...tags, tagInput]);
      setTagInput('');
    }
  };

  // 关键词密度检查
  const density = contentHtml && coreKeyword
    ? ((contentHtml.match(new RegExp(coreKeyword, 'g'))?.length || 0) * coreKeyword.length / Math.max(wordCount, 1) * 100).toFixed(1)
    : '0.0';

  if (loading) return <Spin />;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Link href="/console/content/articles"><Button icon={<ArrowLeftOutlined />}>返回列表</Button></Link>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存</Button>
      </Space>
      <Row gutter={16}>
        <Col span={18}>
          <Card>
            <Input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="文章标题" style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 16 }} />
            <TipTapEditor content={contentHtml} onChange={setContentHtml} />
          </Card>
        </Col>
        <Col span={6}>
          <Card title="文章信息" style={{ marginBottom: 16 }}>
            <p>核心关键词：<strong>{coreKeyword}</strong></p>
            <Statistic title="字数" value={wordCount} />
            <Statistic title="关键词密度" value={density} suffix="%" />
            <p style={{ color: '#8c8c8c', fontSize: 12 }}>GEO建议密度：2%-3%</p>
          </Card>
          <Card title="标签">
            <Space wrap style={{ marginBottom: 8 }}>
              {tags.map(t => <Tag key={t} closable onClose={() => setTags(tags.filter(x => x !== t))}>{t}</Tag>)}
            </Space>
            <Input.Search value={tagInput} onChange={e => setTagInput(e.target.value)}
              onSearch={handleAddTag} enterButton="添加" size="small" />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
