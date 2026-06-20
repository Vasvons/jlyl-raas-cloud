'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Input, Popconfirm, message, Select, Card, Tag, Checkbox, Tabs, Row, Col } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, ThunderboltOutlined, ExperimentOutlined, TagsOutlined, KeyOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface PPItem {
  id: number;
  userId: string;
  pp: string;
}

interface DistillateKeywordItem {
  id: number;
  userId: string;
  distillateKeyword: string;
}

interface ZlgjcItem {
  id: number;
  userId: string;
  value: string;
  hxgjc: string;
  lxfs: string;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

// 蒸馏关键词生成器的默认词组
const DEFAULT_WORDS = {
  A: ['市面上', '行业内', '市场', '目前', '国内'],
  B: ['口碑好的', '比较好的', '靠谱的', '有实力的', '可靠的', '诚信的', '正规的', '专业的', '热门的', '知名的', '优秀的'],
  D: ['品牌', '公司', '工厂', '厂家', '厂商', '生产厂家', '源头厂家', '批发厂家', '加工厂'],
  E: ['推荐', '排行', '推荐榜', '排行榜', '排名'],
  F: ['哪家好', '哪家强', '哪家靠谱', '推荐几家'],
};

// 蒸馏关键词可选的组合规则
const COMBO_OPTIONS = [
  'C+D', 'A+C+D', 'B+C+D', 'A+B+C+D',
  'C+D+E', 'C+D+F', 'A+C+D+E', 'B+C+D+E',
  'A+B+C+D+E', 'A+B+C+D+F',
];

// 品牌关键词默认词组
const DEFAULT_BRAND_WORDS = {
  C: ['怎么样', '好不好', '哪个好', '靠谱吗', '值得买吗', '好不好用'],
  D: ['价格', '报价', '厂家', '多少钱', '费用', '成本'],
};

// 品牌关键词组合规则（A品牌词始终包含，B核心词可选）
const BRAND_COMBO_OPTIONS = [
  'A', 'A+B', 'A+C', 'A+D', 'A+B+C', 'A+B+D', 'A+B+C+D',
];

export default function KeywordsPage() {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  // 品牌词
  const [ppList, setPpList] = useState<PPItem[]>([]);
  const [newPp, setNewPp] = useState('');

  // 核心关键词（distillate_keyword 表）
  const [dkList, setDkList] = useState<DistillateKeywordItem[]>([]);
  const [newDk, setNewDk] = useState('');

  // 蒸馏关键词库（zlgjc 表，keyword_type=0）
  const [zlgjcList, setZlgjcList] = useState<ZlgjcItem[]>([]);
  const [newZlgjcValue, setNewZlgjcValue] = useState('');
  const [newZlgjcHxgjc, setNewZlgjcHxgjc] = useState('');
  const [zlgjcTotal, setZlgjcTotal] = useState(0);
  const [zlgjcPageNum, setZlgjcPageNum] = useState(1);
  const [zlgjcPageSize, setZlgjcPageSize] = useState(20);

  // 品牌关键词库（zlgjc 表，keyword_type=1）
  const [brandList, setBrandList] = useState<ZlgjcItem[]>([]);
  const [newBrandValue, setNewBrandValue] = useState('');
  const [newBrandHxgjc, setNewBrandHxgjc] = useState('');
  const [brandTotal, setBrandTotal] = useState(0);
  const [brandPageNum, setBrandPageNum] = useState(1);
  const [brandPageSize, setBrandPageSize] = useState(20);

  // 蒸馏关键词生成器
  const [genA, setGenA] = useState(DEFAULT_WORDS.A.join('\n'));
  const [genB, setGenB] = useState(DEFAULT_WORDS.B.join('\n'));
  const [genC, setGenC] = useState('');
  const [genD, setGenD] = useState(DEFAULT_WORDS.D.join('\n'));
  const [genE, setGenE] = useState(DEFAULT_WORDS.E.join('\n'));
  const [genF, setGenF] = useState(DEFAULT_WORDS.F.join('\n'));
  const [genCombos, setGenCombos] = useState<string[]>(['C+D', 'A+C+D', 'B+C+D']);
  const [genSubmitting, setGenSubmitting] = useState(false);
  const [genResult, setGenResult] = useState<{ inserted: number; duplicated: number; total: number } | null>(null);

  // 品牌关键词生成器
  const [brandGenB, setBrandGenB] = useState(''); // B核心词，自动从核心关键词填入
  const [brandGenC, setBrandGenC] = useState(DEFAULT_BRAND_WORDS.C.join('\n')); // C疑问词
  const [brandGenD, setBrandGenD] = useState(DEFAULT_BRAND_WORDS.D.join('\n')); // D信息词
  const [brandGenCombos, setBrandGenCombos] = useState<string[]>(['A+B', 'A+B+C']);
  const [brandGenSubmitting, setBrandGenSubmitting] = useState(false);
  const [brandGenResult, setBrandGenResult] = useState<{ inserted: number; duplicated: number; total: number } | null>(null);

  // 获取用户列表
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
        if (res.data?.code === 200) {
          const allUsers = res.data.data?.list || [];
          const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
          setUsers(userList);
          if (userList.length > 0) {
            setSelectedUserId(String(userList[0].id));
          }
        }
      } catch (e) {
        // 忽略
      }
    })();
  }, []);

  const fetchAll = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      await Promise.all([fetchPp(userId), fetchDk(userId), fetchZlgjc(userId), fetchBrand(userId)]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedUserId) {
      fetchAll(selectedUserId);
    }
  }, [selectedUserId]);

  const fetchPp = async (userId: string) => {
    if (!userId) return;
    try {
      const res = await api.get('/pp/list', { params: { userId } });
      if (res.data?.code === 200) {
        setPpList(res.data.data || []);
      }
    } catch (e) {}
  };

  const fetchDk = async (userId: string) => {
    if (!userId) return;
    try {
      const res = await api.get('/dstillateKeyword/getAllDstillateKeyword', { params: { userId, pageNum: 1, pageSize: 9999999 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        const list = Array.isArray(data) ? data : (data?.list || []);
        setDkList(list);
        // 自动将核心关键词填入蒸馏生成器C字段和品牌生成器B字段
        const cWords = list.map((item: DistillateKeywordItem) => item.distillateKeyword).filter(Boolean);
        setGenC(cWords.join('\n'));
        setBrandGenB(cWords.join('\n'));
      }
    } catch (e) {}
  };

  const fetchZlgjc = async (userId: string, page = zlgjcPageNum, size = zlgjcPageSize) => {
    if (!userId) return;
    try {
      const res = await api.get('/zlgjc/select', { params: { userId, pageNum: page, pageSize: size, keywordType: 0 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setZlgjcList(data?.list || []);
        setZlgjcTotal(data?.total || 0);
      }
    } catch (e) {}
  };

  const fetchBrand = async (userId: string, page = brandPageNum, size = brandPageSize) => {
    if (!userId) return;
    try {
      const res = await api.get('/zlgjc/select', { params: { userId, pageNum: page, pageSize: size, keywordType: 1 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setBrandList(data?.list || []);
        setBrandTotal(data?.total || 0);
      }
    } catch (e) {}
  };

  const onUserChange = (uid: string) => {
    setSelectedUserId(uid);
    setGenResult(null);
    setBrandGenResult(null);
  };

  // 品牌词操作
  const addPp = async () => {
    if (!newPp.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/pp/add', { userId: selectedUserId, pp: newPp.trim() });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewPp('');
        fetchPp(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deletePp = async (id: number) => {
    try {
      const res = await api.delete(`/pp/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchPp(selectedUserId);
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 核心关键词操作
  const addDk = async () => {
    if (!newDk.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/dstillateKeyword/insertDstillateKeyword', { userId: selectedUserId, distillateKeyword: newDk.trim() });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewDk('');
        fetchDk(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deleteDk = async (id: number) => {
    try {
      const res = await api.get('/dstillateKeyword/deleteDstillateKeyword', { params: { id } });
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchDk(selectedUserId);
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 蒸馏关键词库操作
  const addZlgjc = async () => {
    if (!newZlgjcValue.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/zlgjc/add', {
        userId: selectedUserId,
        value: newZlgjcValue.trim(),
        hxgjc: newZlgjcHxgjc.trim() || newZlgjcValue.trim(),
        lxfs: '',
        keywordType: 0,
      });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewZlgjcValue('');
        setNewZlgjcHxgjc('');
        fetchZlgjc(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deleteZlgjc = async (id: number) => {
    try {
      const res = await api.delete(`/zlgjc/delete/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchZlgjc(selectedUserId);
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 品牌关键词库操作
  const addBrand = async () => {
    if (!newBrandValue.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/zlgjc/add', {
        userId: selectedUserId,
        value: newBrandValue.trim(),
        hxgjc: newBrandHxgjc.trim() || newBrandValue.trim(),
        lxfs: '',
        keywordType: 1,
      });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewBrandValue('');
        setNewBrandHxgjc('');
        fetchBrand(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deleteBrand = async (id: number) => {
    try {
      const res = await api.delete(`/zlgjc/delete/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchBrand(selectedUserId);
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 生成蒸馏关键词
  const handleGenerate = async () => {
    if (!selectedUserId) {
      message.warning('请先选择用户');
      return;
    }
    if (genCombos.length === 0) {
      message.warning('请至少选择一个组合规则');
      return;
    }
    const cWords = genC.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    if (cWords.length === 0) {
      message.warning('C主词不能为空，请先添加核心关键词');
      return;
    }
    setGenSubmitting(true);
    setGenResult(null);
    try {
      const payload = {
        userId: selectedUserId,
        A: genA ? genA.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        B: genB ? genB.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        C: cWords,
        D: genD ? genD.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        E: genE ? genE.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        F: genF ? genF.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        G: genCombos,
        keywordType: 0,
      };
      const res = await api.post('/keywordsearchrank/generate', payload);
      if (res.data?.code === 200) {
        const result = res.data.data;
        setGenResult(result);
        message.success(`生成完成：新增 ${result.inserted} 条，重复 ${result.duplicated} 条`);
        fetchZlgjc(selectedUserId);
      } else {
        message.error(res.data?.message || '生成失败');
      }
    } catch (e) {
      message.error('生成失败');
    } finally {
      setGenSubmitting(false);
    }
  };

  // 生成品牌关键词
  const handleBrandGenerate = async () => {
    if (!selectedUserId) {
      message.warning('请先选择用户');
      return;
    }
    const aWords = ppList.map((p) => p.pp).filter(Boolean);
    if (aWords.length === 0) {
      message.warning('A品牌词为空，请先添加品牌词');
      return;
    }
    const bWords = brandGenB ? brandGenB.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [];
    // B核心词不再强制，但若所选组合包含B而B为空，需提示
    const combosNeedB = brandGenCombos.some((c) => c.includes('B'));
    if (combosNeedB && bWords.length === 0) {
      message.warning('所选组合包含B核心词，但B核心词为空');
      return;
    }
    if (brandGenCombos.length === 0) {
      message.warning('请至少选择一个组合规则');
      return;
    }
    setBrandGenSubmitting(true);
    setBrandGenResult(null);
    try {
      const payload = {
        userId: selectedUserId,
        A: aWords,
        B: bWords,
        C: brandGenC ? brandGenC.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        D: brandGenD ? brandGenD.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : [],
        E: [],
        F: [],
        G: brandGenCombos,
        keywordType: 1,
      };
      const res = await api.post('/keywordsearchrank/generate', payload);
      if (res.data?.code === 200) {
        const result = res.data.data;
        setBrandGenResult(result);
        message.success(`生成完成：新增 ${result.inserted} 条，重复 ${result.duplicated} 条`);
        fetchBrand(selectedUserId);
      } else {
        message.error(res.data?.message || '生成失败');
      }
    } catch (e) {
      message.error('生成失败');
    } finally {
      setBrandGenSubmitting(false);
    }
  };

  const ppColumns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '品牌词', dataIndex: 'pp' },
    {
      title: '操作', width: 80,
      render: (_: any, record: PPItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deletePp(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const dkColumns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '核心关键词', dataIndex: 'distillateKeyword' },
    {
      title: '操作', width: 80,
      render: (_: any, record: DistillateKeywordItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteDk(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const zlgjcColumns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    { title: '蒸馏关键词', dataIndex: 'value', width: 280 },
    { title: '核心词', dataIndex: 'hxgjc', width: 200 },
    {
      title: '联系方式', dataIndex: 'lxfs', width: 130,
      render: (v: string) => v ? <Tag color="green">{v}</Tag> : <Tag>无</Tag>,
    },
    {
      title: '操作', width: 80,
      render: (_: any, record: ZlgjcItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteZlgjc(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const brandColumns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    { title: '品牌关键词', dataIndex: 'value', width: 280 },
    { title: '核心词', dataIndex: 'hxgjc', width: 200 },
    {
      title: '联系方式', dataIndex: 'lxfs', width: 130,
      render: (v: string) => v ? <Tag color="green">{v}</Tag> : <Tag>无</Tag>,
    },
    {
      title: '操作', width: 80,
      render: (_: any, record: ZlgjcItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteBrand(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  // 蒸馏关键词生成器的字段配置
  const distillateFields = [
    { key: 'A', label: 'A 前缀词', value: genA, setter: setGenA, placeholder: '市面上\n行业内' },
    { key: 'B', label: 'B 修饰词', value: genB, setter: setGenB, placeholder: '口碑好的\n比较好的' },
    { key: 'C', label: 'C 主词（必填）', value: genC, setter: setGenC, placeholder: '自动填入核心关键词', required: true },
    { key: 'D', label: 'D 同义词', value: genD, setter: setGenD, placeholder: '公司\n工厂' },
    { key: 'E', label: 'E 推荐词', value: genE, setter: setGenE, placeholder: '推荐\n排行' },
    { key: 'F', label: 'F 疑问词', value: genF, setter: setGenF, placeholder: '哪家好\n哪家强' },
  ];

  // 品牌关键词生成器的字段配置（C疑问词和D信息词位置已对调：D在前，C在后）
  const brandFields = [
    { key: 'A', label: 'A 品牌词（自动）', value: ppList.map((p) => p.pp).join('\n'), setter: () => {}, placeholder: '自动填入品牌词', readOnly: true },
    { key: 'B', label: 'B 核心词（自动）', value: brandGenB, setter: setBrandGenB, placeholder: '自动填入核心关键词', readOnly: true },
    { key: 'D', label: 'D 信息词', value: brandGenD, setter: setBrandGenD, placeholder: '价格\n报价' },
    { key: 'C', label: 'C 疑问词', value: brandGenC, setter: setBrandGenC, placeholder: '怎么样\n好不好' },
  ];

  return (
    <div>
      <div className="console-page-title">
        <span className="console-page-title-text">关键词配置</span>
        <Space>
          <span style={{ fontSize: 13, color: '#666' }}>选择用户：</span>
          <Select
            style={{ width: 200 }}
            value={selectedUserId}
            onChange={onUserChange}
            placeholder="请选择用户"
            options={users.map((u) => ({ value: String(u.id), label: u.username }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => fetchAll(selectedUserId)} loading={loading}>刷新</Button>
        </Space>
      </div>

      {/* 上方：品牌词 + 核心关键词 并列卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card
            title={<span><TagsOutlined style={{ marginRight: 8 }} />品牌词</span>}
            size="small"
            extra={<Tag color="purple">{ppList.length} 条</Tag>}
            headStyle={{ borderLeft: '3px solid #722ed1', background: '#f9f0ff' }}
          >
            <Space style={{ marginBottom: 12, width: '100%' }}>
              <Input
                placeholder="输入品牌词，回车添加"
                value={newPp}
                onChange={(e) => setNewPp(e.target.value)}
                onPressEnter={addPp}
                style={{ flex: 1 }}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={addPp}>添加</Button>
            </Space>
            <Table dataSource={ppList} columns={ppColumns} rowKey="id" pagination={{ pageSize: 5, simple: true }} size="small" scroll={{ y: 200 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={<span><KeyOutlined style={{ marginRight: 8 }} />核心关键词</span>}
            size="small"
            extra={<Tag color="blue">{dkList.length} 条</Tag>}
            headStyle={{ borderLeft: '3px solid #1677ff', background: '#e6f4ff' }}
          >
            <Space style={{ marginBottom: 12, width: '100%' }}>
              <Input
                placeholder="输入核心关键词（主词），回车添加"
                value={newDk}
                onChange={(e) => setNewDk(e.target.value)}
                onPressEnter={addDk}
                style={{ flex: 1 }}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={addDk}>添加</Button>
            </Space>
            <Table dataSource={dkList} columns={dkColumns} rowKey="id" pagination={{ pageSize: 5, simple: true }} size="small" scroll={{ y: 200 }} />
          </Card>
        </Col>
      </Row>

      {/* 中间：关键词生成器（Tab：蒸馏 + 品牌） */}
      <Card
        title={<span><ExperimentOutlined style={{ marginRight: 8 }} />关键词生成器</span>}
        size="small"
        style={{ marginBottom: 16 }}
        headStyle={{ borderLeft: '3px solid #fa8c16', background: '#fff7e6' }}
      >
        <Tabs
          defaultActiveKey="distillate"
          items={[
            {
              key: 'distillate',
              label: '蒸馏关键词生成器',
              children: (
                <div>
                  <div className="console-tip console-tip-info" style={{ marginBottom: 12 }}>
                    <b>使用说明：</b>在下方各字段输入词组（每行一个），选择组合规则后点击"生成"。
                    <b>C主词</b>自动从核心关键词填入。组合规则如 <code>C+D</code> 表示将C和D的词两两拼接。
                  </div>
                  <Row gutter={[8, 8]}>
                    {distillateFields.map((f) => (
                      <Col span={4} key={f.key}>
                        <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13, color: f.required ? '#cf1322' : undefined }}>{f.label}</div>
                        <Input.TextArea
                          rows={8}
                          value={f.value}
                          onChange={(e) => f.setter(e.target.value)}
                          placeholder={f.placeholder}
                          style={{ fontSize: 13 }}
                        />
                      </Col>
                    ))}
                  </Row>
                  <div style={{ marginTop: 12, marginBottom: 4, fontWeight: 500, fontSize: 13 }}>G 组合规则</div>
                  <Checkbox.Group value={genCombos} onChange={(values) => setGenCombos(values as string[])} style={{ width: '100%' }}>
                    <Row gutter={[8, 8]}>
                      {COMBO_OPTIONS.map((combo) => (
                        <Col span={6} key={combo}>
                          <Checkbox value={combo} style={{ fontSize: 13 }}>{combo}</Checkbox>
                        </Col>
                      ))}
                    </Row>
                  </Checkbox.Group>
                  <div style={{ marginTop: 12 }}>
                    <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleGenerate} loading={genSubmitting}>生成蒸馏关键词</Button>
                  </div>
                  {genResult && (
                    <div className="console-tip console-tip-success" style={{ marginTop: 12, marginBottom: 0 }}>
                      <Space>
                        <Tag color="green">新增 {genResult.inserted} 条</Tag>
                        <Tag color="orange">重复 {genResult.duplicated} 条</Tag>
                        <Tag color="blue">总计组合 {genResult.total} 条</Tag>
                      </Space>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'brand',
              label: '品牌关键词生成器',
              children: (
                <div>
                  <div className="console-tip console-tip-info" style={{ marginBottom: 12 }}>
                    <b>使用说明：</b>A品牌词自动从品牌词列表填入（始终参与组合），B核心词自动从核心关键词填入（可选，若组合含B则需有值）。
                    D信息词和C疑问词可手动编辑。选择组合规则后点击"生成"。
                  </div>
                  <Row gutter={[8, 8]}>
                    {brandFields.map((f) => (
                      <Col span={6} key={f.key}>
                        <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13, color: f.key === 'A' ? '#722ed1' : (f.key === 'B' ? '#cf1322' : undefined) }}>{f.label}</div>
                        <Input.TextArea
                          rows={8}
                          value={f.value}
                          onChange={f.readOnly ? undefined : (e) => f.setter(e.target.value)}
                          placeholder={f.placeholder}
                          style={{ fontSize: 13 }}
                          disabled={f.readOnly}
                        />
                      </Col>
                    ))}
                  </Row>
                  <div style={{ marginTop: 12, marginBottom: 4, fontWeight: 500, fontSize: 13 }}>组合规则（A品牌词始终包含，B核心词可选）</div>
                  <Checkbox.Group value={brandGenCombos} onChange={(values) => setBrandGenCombos(values as string[])} style={{ width: '100%' }}>
                    <Row gutter={[8, 8]}>
                      {BRAND_COMBO_OPTIONS.map((combo) => (
                        <Col span={6} key={combo}>
                          <Checkbox value={combo} style={{ fontSize: 13 }}>{combo}</Checkbox>
                        </Col>
                      ))}
                    </Row>
                  </Checkbox.Group>
                  <div style={{ marginTop: 12 }}>
                    <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleBrandGenerate} loading={brandGenSubmitting}>生成品牌关键词</Button>
                  </div>
                  {brandGenResult && (
                    <div className="console-tip console-tip-success" style={{ marginTop: 12, marginBottom: 0 }}>
                      <Space>
                        <Tag color="green">新增 {brandGenResult.inserted} 条</Tag>
                        <Tag color="orange">重复 {brandGenResult.duplicated} 条</Tag>
                        <Tag color="blue">总计组合 {brandGenResult.total} 条</Tag>
                      </Space>
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      {/* 下方：关键词库（Tab：蒸馏 + 品牌） */}
      <Card
        size="small"
        headStyle={{ borderLeft: '3px solid #13c2c2', background: '#e6fffb' }}
      >
        <Tabs
          defaultActiveKey="distillate"
          items={[
            {
              key: 'distillate',
              label: <span>蒸馏关键词库 <Tag color="blue" style={{ marginLeft: 4 }}>{zlgjcTotal}</Tag></span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Input
                      placeholder="蒸馏关键词（组合词）"
                      value={newZlgjcValue}
                      onChange={(e) => setNewZlgjcValue(e.target.value)}
                      onPressEnter={addZlgjc}
                      style={{ width: 250 }}
                    />
                    <Input
                      placeholder="核心词（默认同上）"
                      value={newZlgjcHxgjc}
                      onChange={(e) => setNewZlgjcHxgjc(e.target.value)}
                      onPressEnter={addZlgjc}
                      style={{ width: 250 }}
                    />
                    <Button type="primary" icon={<PlusOutlined />} onClick={addZlgjc}>手动添加</Button>
                  </Space>
                  <Table
                    loading={loading}
                    dataSource={zlgjcList}
                    columns={zlgjcColumns}
                    rowKey="id"
                    pagination={{
                      current: zlgjcPageNum,
                      pageSize: zlgjcPageSize,
                      total: zlgjcTotal,
                      showSizeChanger: true,
                      showTotal: (t) => `共 ${t} 条`,
                      onChange: (page, size) => {
                        setZlgjcPageNum(page);
                        setZlgjcPageSize(size || 20);
                        fetchZlgjc(selectedUserId, page, size || 20);
                      },
                    }}
                    size="small"
                  />
                </div>
              ),
            },
            {
              key: 'brand',
              label: <span>品牌关键词库 <Tag color="purple" style={{ marginLeft: 4 }}>{brandTotal}</Tag></span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Input
                      placeholder="品牌关键词"
                      value={newBrandValue}
                      onChange={(e) => setNewBrandValue(e.target.value)}
                      onPressEnter={addBrand}
                      style={{ width: 250 }}
                    />
                    <Input
                      placeholder="核心词（默认同上）"
                      value={newBrandHxgjc}
                      onChange={(e) => setNewBrandHxgjc(e.target.value)}
                      onPressEnter={addBrand}
                      style={{ width: 250 }}
                    />
                    <Button type="primary" icon={<PlusOutlined />} onClick={addBrand}>手动添加</Button>
                  </Space>
                  <Table
                    loading={loading}
                    dataSource={brandList}
                    columns={brandColumns}
                    rowKey="id"
                    pagination={{
                      current: brandPageNum,
                      pageSize: brandPageSize,
                      total: brandTotal,
                      showSizeChanger: true,
                      showTotal: (t) => `共 ${t} 条`,
                      onChange: (page, size) => {
                        setBrandPageNum(page);
                        setBrandPageSize(size || 20);
                        fetchBrand(selectedUserId, page, size || 20);
                      },
                    }}
                    size="small"
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
