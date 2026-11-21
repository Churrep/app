ALTER TABLE bands
    ALTER COLUMN created_by SET NOT NULL,
    DROP CONSTRAINT bands_created_by_fkey,
    ADD CONSTRAINT bands_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT;
