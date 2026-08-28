CREATE DATABASE IF NOT EXISTS securityshoop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE securityshoop;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  hwid VARCHAR(255) NULL,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  is_blocked TINYINT(1) NOT NULL DEFAULT 0,
  session_token VARCHAR(128) NULL,
  token_created_at DATETIME NULL,
  license_until DATETIME NULL,
  daily_limit INT NOT NULL DEFAULT 0,
  allowed_appids TEXT NULL,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'approved',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  username VARCHAR(100) NULL,
  email VARCHAR(190) NULL,
  action VARCHAR(80) NOT NULL,
  details TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_logs_created_at (created_at),
  INDEX idx_activity_logs_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hwid_bans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  hwid VARCHAR(255) NOT NULL UNIQUE,
  user_id INT NULL,
  email VARCHAR(190) NULL,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hwid_bans_hwid (hwid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS app_keys (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(190) NULL,
  status ENUM('active','used','blocked') NOT NULL DEFAULT 'active',
  assigned_hwid VARCHAR(255) NULL,
  first_ip VARCHAR(80) NULL,
  last_ip VARCHAR(80) NULL,
  first_used_at DATETIME NULL,
  last_seen_at DATETIME NULL,
  expires_at DATETIME NULL,
  created_by VARCHAR(190) NULL,
  note TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_app_keys_status (status),
  INDEX idx_app_keys_hwid (assigned_hwid),
  INDEX idx_app_keys_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  key_id BIGINT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  hwid VARCHAR(255) NOT NULL,
  device_name VARCHAR(190) NULL,
  app_version VARCHAR(80) NULL,
  ip VARCHAR(80) NULL,
  status ENUM('online','offline','blocked') NOT NULL DEFAULT 'online',
  started_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  INDEX idx_app_sessions_key (key_id),
  INDEX idx_app_sessions_last_seen (last_seen_at),
  INDEX idx_app_sessions_hwid (hwid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS securityshoop_token_store (
  id TINYINT UNSIGNED PRIMARY KEY,
  data LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
