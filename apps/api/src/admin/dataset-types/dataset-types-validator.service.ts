import { Injectable, HttpException } from '@nestjs/common';
import * as path from 'path';

@Injectable()
export class DatasetTypesValidatorService {
  validateDatasetPath(datasetPath: string): void {
    if (!datasetPath || typeof datasetPath !== 'string') {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: 'Dataset path must be a non-empty string' } },
        400,
      );
    }

    this.validatePathFormat(datasetPath, 'dataset_path');
  }

  validateModelPath(modelPath: string): void {
    if (!modelPath || typeof modelPath !== 'string') {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: 'Model path must be a non-empty string' } },
        400,
      );
    }

    this.validatePathFormat(modelPath, 'model_path');
  }

  private validatePathFormat(inputPath: string, fieldName: string): void {
    if (!inputPath.startsWith('/')) {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: `${fieldName} must be an absolute path` } },
        400,
      );
    }

    if (inputPath.includes('\0') || inputPath.includes('..')) {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: `${fieldName} must not contain null bytes or ..` } },
        400,
      );
    }
  }
}
