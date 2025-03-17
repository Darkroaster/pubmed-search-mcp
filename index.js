const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// PubMed API基础URL
const PUBMED_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// 搜索PubMed文章
app.post('/api/search', async (req, res) => {
  try {
    const { query, maxResults = 10, sortBy = 'relevance' } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: '搜索查询不能为空' });
    }

    // 构建排序参数
    let sort = '';
    switch (sortBy) {
      case 'date':
        sort = 'pub+date';
        break;
      case 'relevance':
      default:
        sort = 'relevance';
        break;
    }

    // 首先搜索获取ID列表
    const searchResponse = await axios.get(`${PUBMED_BASE_URL}/esearch.fcgi`, {
      params: {
        db: 'pubmed',
        term: query,
        retmax: maxResults,
        sort,
        retmode: 'json'
      }
    });

    const ids = searchResponse.data.esearchresult.idlist;
    
    if (!ids || ids.length === 0) {
      return res.json({ articles: [] });
    }

    // 然后获取这些ID的详细信息
    const summaryResponse = await axios.get(`${PUBMED_BASE_URL}/esummary.fcgi`, {
      params: {
        db: 'pubmed',
        id: ids.join(','),
        retmode: 'json'
      }
    });

    const results = summaryResponse.data.result;
    
    // 处理结果
    const articles = ids.map(id => {
      const article = results[id];
      return {
        id,
        title: article.title,
        authors: article.authors ? article.authors.map(author => author.name).join(', ') : '未知作者',
        journal: article.fulljournalname || article.source || '未知期刊',
        pubDate: article.pubdate || '未知日期',
        abstract: article.abstract || '无摘要',
        doi: article.elocationid ? article.elocationid.replace('doi: ', '') : null,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
      };
    });

    res.json({ articles });
  } catch (error) {
    console.error('PubMed搜索错误:', error);
    res.status(500).json({ error: '搜索PubMed时出错', details: error.message });
  }
});

// 获取文章详情
app.get('/api/article/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 获取文章详细信息
    const fetchResponse = await axios.get(`${PUBMED_BASE_URL}/efetch.fcgi`, {
      params: {
        db: 'pubmed',
        id,
        retmode: 'xml'
      }
    });

    // 解析XML响应
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(fetchResponse.data);
    
    const articleSet = result.PubmedArticleSet.PubmedArticle;
    
    if (!articleSet) {
      return res.status(404).json({ error: '未找到文章' });
    }

    const article = articleSet.MedlineCitation.Article;
    const pmid = articleSet.MedlineCitation.PMID._;
    
    // 提取摘要
    let abstract = '无摘要';
    if (article.Abstract && article.Abstract.AbstractText) {
      if (Array.isArray(article.Abstract.AbstractText)) {
        abstract = article.Abstract.AbstractText.map(section => {
          if (typeof section === 'object' && section._) {
            return `${section.$ && section.$.Label ? section.$.Label + ': ' : ''}${section._}`;
          }
          return section;
        }).join('\n');
      } else {
        abstract = article.Abstract.AbstractText;
      }
    }
    
    // 提取作者
    let authors = [];
    if (article.AuthorList && article.AuthorList.Author) {
      if (Array.isArray(article.AuthorList.Author)) {
        authors = article.AuthorList.Author.map(author => {
          const lastName = author.LastName || '';
          const foreName = author.ForeName || '';
          return `${lastName}${lastName && foreName ? ' ' : ''}${foreName}`;
        });
      } else {
        const author = article.AuthorList.Author;
        const lastName = author.LastName || '';
        const foreName = author.ForeName || '';
        authors = [`${lastName}${lastName && foreName ? ' ' : ''}${foreName}`];
      }
    }
    
    // 提取DOI
    let doi = null;
    if (articleSet.PubmedData && articleSet.PubmedData.ArticleIdList && articleSet.PubmedData.ArticleIdList.ArticleId) {
      const articleIds = Array.isArray(articleSet.PubmedData.ArticleIdList.ArticleId) 
        ? articleSet.PubmedData.ArticleIdList.ArticleId 
        : [articleSet.PubmedData.ArticleIdList.ArticleId];
      
      const doiObject = articleIds.find(idObj => idObj.$ && idObj.$.IdType === 'doi');
      if (doiObject) {
        doi = doiObject._;
      }
    }
    
    const articleDetail = {
      id: pmid,
      title: article.ArticleTitle || '无标题',
      authors: authors.join(', ') || '未知作者',
      journal: article.Journal.Title || '未知期刊',
      pubDate: article.Journal.JournalIssue.PubDate.Year || article.Journal.JournalIssue.PubDate.MedlineDate || '未知日期',
      abstract,
      doi,
      keywords: articleSet.MedlineCitation.KeywordList 
        ? (Array.isArray(articleSet.MedlineCitation.KeywordList.Keyword) 
          ? articleSet.MedlineCitation.KeywordList.Keyword.map(k => k._) 
          : [articleSet.MedlineCitation.KeywordList.Keyword._]) 
        : [],
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    };

    res.json({ article: articleDetail });
  } catch (error) {
    console.error('获取PubMed文章详情错误:', error);
    res.status(500).json({ error: '获取文章详情时出错', details: error.message });
  }
});

// MCP清单端点
app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'PubMed搜索',
    name_for_model: 'pubmed_search',
    description_for_human: '搜索PubMed上的医学和生物医学文章',
    description_for_model: '允许搜索PubMed数据库中的医学和生物医学文章，获取文章摘要和详细信息',
    auth: {
      type: 'none'
    },
    api: {
      type: 'openapi',
      url: `${req.protocol}://${req.get('host')}/.well-known/openapi.yaml`
    },
    logo_url: `${req.protocol}://${req.get('host')}/logo.png`,
    contact_email: 'contact@example.com',
    legal_info_url: 'https://example.com/legal'
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});