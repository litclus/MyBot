-- 首次初始化数据卷时执行（docker-entrypoint-initdb.d）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 启动日志里核对版本，pgvector 需要 >= 0.8 才支持 hnsw.iterative_scan
DO
$$
BEGIN
    RAISE NOTICE 'pgvector %', (SELECT extversion FROM pg_extension WHERE extname = 'vector');
    RAISE NOTICE 'pg_trgm  %', (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm');
END
$$;
