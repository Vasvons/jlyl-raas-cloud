'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Table, Button, Space, Input, Popconfirm, message, Select, Card, Tag, Checkbox, InputNumber, Divider, Row, Col, Statistic } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, ThunderboltOutlined, ExperimentOutlined } from '@ant-design/icons';
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

// 可选的组合规则
const COMBO_OPTIONS = [
  'C+D', 'A+C+D', 'B+C+D', 'A+B+C+D',
  'C+D+E', 'C+D+F', 'A+C+D+E', 'B+C+D+E',
  'A+B+C+D+E', 'A+B+C+D+F',
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

  // 蒸馏关键词库（zlgjc 表）
  const [zlgjcList, setZlgjcList] = useState<ZlgjcItem[]>([]);
  const [newZlgjcValue, setNewZlgjcValue] = useState('');
  const [newZlgjcHxgjc, setNewZlgjcHxgjc] = useState('');
  const [zlgjcTotal, setZlgjcTotal] = useState(0);
  const [zlgjcPageNum, setZlgjcPageNum] = useState(1);
  const [zlgjcPageSize, setZlgjcPageSize] = useState(20);

  // 蒸馏关键词生成器
  const [genA, setGenA] = useState(DEFAULT_WORDS.A.join('\n'));
  const [genB, setGenB] = useState(DEFAULT_WORDS.B.join('\n'));
  const [genC, setGenC] = useState(''); // C主词，从核心关键词自动填入
  const [genD, setGenD] = useState(DEFAULT_WORDS.D.join('\n'));
  const [genE, setGenE] = useState(DEFAULT_WORDS.E.join('\n'));
  const [genF, setGenF] = useState(DEFAULT_WORDS.F.join('\n'));
  const [genCombos, setGenCombos] = useState<string[]>(['C+D', 'A+C+D', 'B+C+D']);
  const [genCount, setGenCount] = useState(20000);
  const [genSubmitting, setGenSubmitting] = useState(false);
  const [genResult, setGenResult] = useState<{ inserted: number; duplicated: number; total: number } | null>(null);

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

  // 获取所有数据
  const fetchAll = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      await Promise.all([fetchPp(userId), fetchDk(userId), fetchZlgjc(userId)]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedUserId) {
      fetchAll(selectedUserId);
    }
  }, [selectedUserId]);

  // 获取品牌词
  const fetchPp = async (userId: string) => {
    if (!userId) return;
    try {
      const res = await api.get('/pp/list', { params: { userId } });
      if (res.data?.code === 200) {
        setPpList(res.data.data || []);
      }
    } catch (e) {
      // 忽略
    }
  };

  // 获取核心关键词
  const fetchDk = async (userId: string) => {
    if (!userId) return;
    try {
      const res = await api.get('/dstillateKeyword/getAllDstillateKeyword', { params: { userId, pageNum: 1, pageSize: 9999999 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        const list = Array.isArray(data) ? data : (data?.list || []);
        setDkList(list);
        // 自动将核心关键词填入生成器C字段
        const cWords = list.map((item: DistillateKeywordItem) => item.distillateKeyword).filter(Boolean);
        setGenC(cWords.join('\n'));
      }
    } catch (e) {
      // 忽略
    }
  };

  // 获取蒸馏关键词库
  const fetchZlgjc = async (userId: string, page = zlgjcPageNum, size = zlgjcPageSize) => {
    if (!userId) return;
    try {
      const res = await api.get('/zlgjc/select', { params: { userId, pageNum: page, pageSize: size } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setZlgjcList(data?.list || []);
        setZlgjcTotal(data?.total || 0);
      }
    } catch (e) {
      // 忽略
    }
  };

  const onUserChange = (uid: string) => {
    setSelectedUserId(uid);
    setGenResult(null);
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
        fetchDk(selectedUserId); // 会自动更新生成器C字段
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
      });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewZlgjcValue('');
        setNewZlgjcHxgjc('');
        fetchZlgjc(selectedUserId);
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
        count: genCount,
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>关键词配置</h2>
        <Space>
          <span>选择用户：</span>
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
            title="品牌词"
            size="small"
            extra={<Tag color="blue">{ppList.length} 条</Tag>}
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
            <Table
              dataSource={ppList}
              columns={ppColumns}
              rowKey="id"
              pagination={{ pageSize: 5, simple: true }}
              size="small"
              scroll={{ y: 200 }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title="核心关键词"
            size="small"
            extra={<Tag color="blue">{dkList.length} 条</Tag>}
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
            <Table
              dataSource={dkList}
              columns={dkColumns}
              rowKey="id"
              pagination={{ pageSize: 5, simple: true }}
              size="small"
              scroll={{ y: 200 }}
            />
          </Card>
        </Col>
      </Row>

      {/* 中间：蒸馏关键词生成器 */}
      <Card
        title={<span><ExperimentOutlined style={{ marginRight: 8 }} />蒸馏关键词生成器</span>}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <span>生成数量：</span>
            <InputNumber
              min={1}
              max={100000}
              value={genCount}
              onChange={(v) => setGenCount(v || 20000)}
              style={{ width: 120 }}
            />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={handleGenerate}
              loading={genSubmitting}
            >
              生成
            </Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 12, padding: 10, background: '#f6f8fa', borderRadius: 4, fontSize: 12, color: '#666' }}>
          <b>使用说明：</b>在下方各字段输入词组（每行一个），选择组合规则后点击"生成"。
          <b>C主词</b>自动从核心关键词填入，也可手动编辑。
          <b>组合规则</b>如 <code>C+D</code> 表示将C和D的词两两拼接，C位置的词作为核心词。
        </div>
        <Row gutter={16}>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>A 前缀词（每行一个）</div>
            <Input.TextArea
              rows={5}
              value={genA}
              onChange={(e) => setGenA(e.target.value)}
              placeholder="例如：&#10;市面上&#10;行业内"
              style={{ fontSize: 12 }}
            />
          </Col>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>B 修饰词（每行一个）</div>
            <Input.TextArea
              rows={5}
              value={genB}
              onChange={(e) => setGenB(e.target.value)}
              placeholder="例如：&#10;口碑好的&#10;比较好的"
              style={{ fontSize: 12 }}
            />
          </Col>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13, color: '#cf1322' }}>C 主词（必填，自动填入）</div>
            <Input.TextArea
              rows={5}
              value={genC}
              onChange={(e) => setGenC(e.target.value)}
              placeholder="核心关键词会自动填入此处，也可手动编辑"
              style={{ fontSize: 12, borderColor: '#ffa39e' }}
            />
          </Col>
        </Row>
        <Row gutter={16} style={{ marginTop: 12 }}>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>D 同义词（每行一个）</div>
            <Input.TextArea
              rows={4}
              value={genD}
              onChange={(e) => setGenD(e.target.value)}
              placeholder="例如：&#10;公司&#10;工厂"
              style={{ fontSize: 12 }}
            />
          </Col>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>E 推荐词（每行一个）</div>
            <Input.TextArea
              rows={4}
              value={genE}
              onChange={(e) => setGenE(e.target.value)}
              placeholder="例如：&#10;推荐&#10;排行"
              style={{ fontSize: 12 }}
            />
          </Col>
          <Col span={8}>
            <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>F 疑问词（每行一个）</div>
            <Input.TextArea
              rows={4}
              value={genF}
              onChange={(e) => setGenF(e.target.value)}
              placeholder="例如：&#10;哪家好&#10;哪家强"
              style={{ fontSize: 12 }}
            />
          </Col>
        </Row>
        <Divider style={{ margin: '12px 0' }} />
        <div style={{ marginBottom: 4, fontWeight: 500, fontSize: 13 }}>G 组合规则（勾选要使用的组合）</div>
        <Checkbox.Group
          value={genCombos}
          onChange={(values) => setGenCombos(values as string[])}
          style={{ width: '100%' }}
        >
          <Row gutter={[8, 8]}>
            {COMBO_OPTIONS.map((combo) => (
              <Col span={6} key={combo}>
                <Checkbox value={combo} style={{ fontSize: 13 }}>{combo}</Checkbox>
              </Col>
            ))}
          </Row>
        </Checkbox.Group>
        {genResult && (
          <div style={{ marginTop: 12, padding: 10, background: '#f0f9ff', borderRadius: 4 }}>
            <Space>
              <Tag color="green">新增 {genResult.inserted} 条</Tag>
              <Tag color="orange">重复 {genResult.duplicated} 条</Tag>
              <Tag color="blue">总计组合 {genResult.total} 条</Tag>
            </Space>
          </div>
        )}
      </Card>

      {/* 下方：蒸馏关键词库 */}
      <Card
        title="蒸馏关键词库"
        size="small"
        extra={<Tag color="blue">共 {zlgjcTotal} 条</Tag>}
      >
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
      </Card>
    </div>
  );
}
