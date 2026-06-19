'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Input, Popconfirm, message, Select, Card, Tabs, Tag, Modal, Form, InputNumber } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
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

export default function KeywordsPage() {
  const [activeTab, setActiveTab] = useState('zlgjc');
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  // 品牌词
  const [ppList, setPpList] = useState<PPItem[]>([]);
  const [newPp, setNewPp] = useState('');

  // 蒸馏关键词
  const [dkList, setDkList] = useState<DistillateKeywordItem[]>([]);
  const [newDk, setNewDk] = useState('');

  // 核心词（zlgjc）
  const [zlgjcList, setZlgjcList] = useState<ZlgjcItem[]>([]);
  const [newZlgjcValue, setNewZlgjcValue] = useState('');
  const [newZlgjcHxgjc, setNewZlgjcHxgjc] = useState('');
  const [zlgjcTotal, setZlgjcTotal] = useState(0);
  const [zlgjcPageNum, setZlgjcPageNum] = useState(1);
  const [zlgjcPageSize, setZlgjcPageSize] = useState(20);

  // 生成蒸馏关键词
  const [genModalVisible, setGenModalVisible] = useState(false);
  const [genSubmitting, setGenSubmitting] = useState(false);
  const [genForm] = Form.useForm();
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

  // 获取品牌词
  const fetchPp = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await api.get('/pp/list', { params: { userId } });
      if (res.data?.code === 200) {
        setPpList(res.data.data || []);
      }
    } catch (e) {
      message.error('获取品牌词失败');
    } finally {
      setLoading(false);
    }
  };

  // 获取蒸馏关键词
  const fetchDk = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await api.get('/dstillateKeyword/getAllDstillateKeyword', { params: { userId, pageNum: 1, pageSize: 9999999 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setDkList(Array.isArray(data) ? data : (data?.list || []));
      }
    } catch (e) {
      message.error('获取蒸馏关键词失败');
    } finally {
      setLoading(false);
    }
  };

  // 获取核心词
  const fetchZlgjc = async (userId: string, page = zlgjcPageNum, size = zlgjcPageSize) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await api.get('/zlgjc/select', { params: { userId, pageNum: page, pageSize: size } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setZlgjcList(data?.list || []);
        setZlgjcTotal(data?.total || 0);
      }
    } catch (e) {
      message.error('获取核心词失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedUserId) {
      if (activeTab === 'pp') fetchPp(selectedUserId);
      else if (activeTab === 'dk') fetchDk(selectedUserId);
      else if (activeTab === 'zlgjc') fetchZlgjc(selectedUserId);
    }
  }, [selectedUserId, activeTab]);

  const onUserChange = (uid: string) => {
    setSelectedUserId(uid);
  };

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
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

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
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 核心词操作
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
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  // 生成蒸馏关键词
  const handleGenerate = async (values: any) => {
    if (!selectedUserId) {
      message.warning('请先选择用户');
      return;
    }
    setGenSubmitting(true);
    setGenResult(null);
    try {
      const payload: any = {
        userId: selectedUserId,
        A: values.A ? String(values.A).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        B: values.B ? String(values.B).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        C: values.C ? String(values.C).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        D: values.D ? String(values.D).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        E: values.E ? String(values.E).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        F: values.F ? String(values.F).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
        G: values.G ? String(values.G).split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean) : [],
      };
      const res = await api.post('/keywordsearchrank/generate', payload);
      if (res.data?.code === 200) {
        const result = res.data.data;
        setGenResult(result);
        message.success(`生成完成：新增 ${result.inserted} 条，重复 ${result.duplicated} 条`);
        // 刷新蒸馏关键词列表（生成的关键词插入 zlgjc 表）并自动切换到该 Tab
        fetchZlgjc(selectedUserId);
        setActiveTab('zlgjc');
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
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '品牌词', dataIndex: 'pp' },
    {
      title: '操作', width: 100,
      render: (_: any, record: PPItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deletePp(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  const dkColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword' },
    {
      title: '操作', width: 100,
      render: (_: any, record: DistillateKeywordItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteDk(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  const zlgjcColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '蒸馏关键词', dataIndex: 'value', width: 250 },
    { title: '核心词', dataIndex: 'hxgjc', width: 200 },
    {
      title: '联系方式', dataIndex: 'lxfs', width: 150,
      render: (v: string) => v ? <Tag color="green">{v}</Tag> : <Tag>无</Tag>,
    },
    {
      title: '操作', width: 100,
      render: (_: any, record: ZlgjcItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteZlgjc(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
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
          <Button icon={<ReloadOutlined />} onClick={() => {
            if (activeTab === 'pp') fetchPp(selectedUserId);
            else if (activeTab === 'dk') fetchDk(selectedUserId);
            else if (activeTab === 'zlgjc') fetchZlgjc(selectedUserId);
          }}>刷新</Button>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => {
            genForm.resetFields();
            setGenResult(null);
            setGenModalVisible(true);
          }}>生成蒸馏关键词</Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'pp',
            label: '品牌词',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Input
                    placeholder="请输入品牌词"
                    value={newPp}
                    onChange={(e) => setNewPp(e.target.value)}
                    onPressEnter={addPp}
                    style={{ width: 300 }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={addPp}>添加品牌词</Button>
                </Space>
                <Table
                  loading={loading}
                  dataSource={ppList}
                  columns={ppColumns}
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  size="small"
                />
              </div>
            ),
          },
          {
            key: 'dk',
            label: '核心关键词',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Input
                    placeholder="请输入核心关键词（用于生成蒸馏关键词的主词）"
                    value={newDk}
                    onChange={(e) => setNewDk(e.target.value)}
                    onPressEnter={addDk}
                    style={{ width: 300 }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={addDk}>添加核心关键词</Button>
                </Space>
                <Table
                  loading={loading}
                  dataSource={dkList}
                  columns={dkColumns}
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  size="small"
                />
              </div>
            ),
          },
          {
            key: 'zlgjc',
            label: '蒸馏关键词',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Input
                    placeholder="蒸馏关键词（组合词）"
                    value={newZlgjcValue}
                    onChange={(e) => setNewZlgjcValue(e.target.value)}
                    onPressEnter={addZlgjc}
                    style={{ width: 250 }}
                  />
                  <Input
                    placeholder="核心词（主词，默认同上）"
                    value={newZlgjcHxgjc}
                    onChange={(e) => setNewZlgjcHxgjc(e.target.value)}
                    onPressEnter={addZlgjc}
                    style={{ width: 250 }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={addZlgjc}>添加蒸馏关键词</Button>
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
        ]}
      />

      {/* 生成蒸馏关键词弹窗 */}
      <Modal
        title="生成蒸馏关键词（组合规则）"
        open={genModalVisible}
        onCancel={() => setGenModalVisible(false)}
        onOk={() => genForm.submit()}
        confirmLoading={genSubmitting}
        destroyOnClose
        width={700}
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#f6f8fa', borderRadius: 4, fontSize: 13, color: '#666' }}>
          <p style={{ margin: '0 0 4px 0' }}><b>使用说明：</b>在下方各字段输入词组（逗号或换行分隔），选择组合规则生成蒸馏关键词。</p>
          <p style={{ margin: '0 0 4px 0' }}><b>组合规则：</b>使用字母组合，如 <code>C+D</code> 表示将C字段和D字段的词两两拼接。<b>C字段为主词，必填。</b></p>
          <p style={{ margin: 0 }}><b>示例：</b>C=[优化, 营销], D=[公司, 服务], 规则=C+D → 优化公司、优化服务、营销公司、营销服务</p>
        </div>
        <Form form={genForm} layout="vertical" onFinish={handleGenerate}>
          <Form.Item label="A 词组（逗号/换行分隔）" name="A">
            <Input.TextArea rows={2} placeholder="例如：北京, 上海, 深圳" />
          </Form.Item>
          <Form.Item label="B 词组（逗号/换行分隔）" name="B">
            <Input.TextArea rows={2} placeholder="例如：专业, 高端, 定制" />
          </Form.Item>
          <Form.Item label="C 词组（主词，必填）" name="C" rules={[{ required: true, message: 'C主词不能为空' }]}>
            <Input.TextArea rows={2} placeholder="例如：优化, 营销, 推广" />
          </Form.Item>
          <Form.Item label="D 词组（逗号/换行分隔）" name="D">
            <Input.TextArea rows={2} placeholder="例如：公司, 服务, 方案" />
          </Form.Item>
          <Form.Item label="E 词组（逗号/换行分隔）" name="E">
            <Input.TextArea rows={2} placeholder="例如：价格, 报价, 多少钱" />
          </Form.Item>
          <Form.Item label="F 词组（逗号/换行分隔）" name="F">
            <Input.TextArea rows={2} placeholder="例如：哪家好, 排行榜" />
          </Form.Item>
          <Form.Item label="G 组合规则（必填，如 C+D、A+C+D）" name="G" rules={[{ required: true, message: '请选择组合规则' }]}>
            <Input.TextArea rows={2} placeholder="例如：C+D, A+C+D, C+E" />
          </Form.Item>
        </Form>
        {genResult && (
          <div style={{ marginTop: 16, padding: 12, background: '#f0f9ff', borderRadius: 4 }}>
            <Tag color="green">新增 {genResult.inserted} 条</Tag>
            <Tag color="orange">重复 {genResult.duplicated} 条</Tag>
            <Tag color="blue">总计组合 {genResult.total} 条</Tag>
          </div>
        )}
      </Modal>
    </div>
  );
}
