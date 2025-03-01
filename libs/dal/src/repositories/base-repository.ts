/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { addDays } from 'date-fns';
import {
  DEFAULT_MESSAGE_GENERIC_RETENTION_DAYS,
  DEFAULT_MESSAGE_IN_APP_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_RETENTION_DAYS,
} from '@novu/shared';
import {
  Model,
  Types,
  ProjectionType,
  FilterQuery,
  UpdateQuery,
  QueryOptions,
  Query,
  QueryWithHelpers,
} from 'mongoose';
import { DalException } from '../shared';

export class BaseRepository<T_DBModel, T_MappedEntity, T_Enforcement> {
  public _model: Model<T_DBModel>;

  constructor(protected MongooseModel: Model<T_DBModel>, protected entity: ClassConstructor<T_MappedEntity>) {
    this._model = MongooseModel;
  }

  public static createObjectId() {
    return new Types.ObjectId().toString();
  }

  public static isInternalId(id: string) {
    const isValidMongoId = Types.ObjectId.isValid(id);
    if (!isValidMongoId) {
      return false;
    }

    return id === new Types.ObjectId(id).toString();
  }

  protected convertObjectIdToString(value: Types.ObjectId): string {
    return value.toString();
  }

  protected convertStringToObjectId(value: string): Types.ObjectId {
    return new Types.ObjectId(value);
  }

  async count(query: FilterQuery<T_DBModel> & T_Enforcement, limit?: number): Promise<number> {
    return this.MongooseModel.countDocuments(query, {
      limit,
    });
  }

  async aggregate(query: any[], options: { readPreference?: 'secondaryPreferred' | 'primary' } = {}): Promise<any> {
    return await this.MongooseModel.aggregate(query).read(options.readPreference || 'primary');
  }

  async findOne(
    query: FilterQuery<T_DBModel> & T_Enforcement,
    select?: ProjectionType<T_MappedEntity>,
    options: { readPreference?: 'secondaryPreferred' | 'primary'; query?: QueryOptions<T_DBModel> } = {}
  ): Promise<T_MappedEntity | null> {
    const data = await this.MongooseModel.findOne(query, select, options.query).read(
      options.readPreference || 'primary'
    );
    if (!data) return null;

    return this.mapEntity(data.toObject());
  }

  async delete(query: FilterQuery<T_DBModel> & T_Enforcement): Promise<{
    /** Indicates whether this writes result was acknowledged. If not, then all other members of this result will be undefined. */
    acknowledged: boolean;
    /** The number of documents that were deleted */
    deletedCount: number;
  }> {
    return await this.MongooseModel.deleteMany(query);
  }

  async find(
    query: FilterQuery<T_DBModel> & T_Enforcement,
    select: ProjectionType<T_MappedEntity> = '',
    options: { limit?: number; sort?: any; skip?: number } = {}
  ): Promise<T_MappedEntity[]> {
    const data = await this.MongooseModel.find(query, select, {
      sort: options.sort || null,
    })
      .skip(options.skip as number)
      .limit(options.limit as number)
      .lean()
      .exec();

    return this.mapEntities(data);
  }

  async *findBatch(
    query: FilterQuery<T_DBModel> & T_Enforcement,
    select = '',
    options: { limit?: number; sort?: any; skip?: number } = {},
    batchSize = 500
  ) {
    for await (const doc of this._model
      .find(query, select, {
        sort: options.sort || null,
      })
      .batchSize(batchSize)
      .cursor()) {
      yield this.mapEntity(doc);
    }
  }

  private async createCursorBasedOrStatement({
    isSortDesc,
    paginateField,
    after,
    queryOrStatements,
  }: {
    isSortDesc: boolean;
    paginateField?: string;
    after: string;
    queryOrStatements?: object[];
  }): Promise<FilterQuery<T_DBModel>[]> {
    const afterItem = await this.MongooseModel.findOne({ _id: after });
    if (!afterItem) {
      throw new DalException('Invalid after id');
    }

    let cursorOrStatements: FilterQuery<T_DBModel>[] = [];
    let enhancedCursorOrStatements: FilterQuery<T_DBModel>[] = [];
    if (paginateField && afterItem[paginateField]) {
      const paginatedFieldValue = afterItem[paginateField];
      cursorOrStatements = [
        { [paginateField]: isSortDesc ? { $lt: paginatedFieldValue } : { $gt: paginatedFieldValue } } as any,
        { [paginateField]: { $eq: paginatedFieldValue }, _id: isSortDesc ? { $lt: after } : { $gt: after } },
      ];
      const firstStatement = (queryOrStatements ?? []).map((item) => ({
        ...item,
        ...cursorOrStatements[0],
      }));
      const secondStatement = (queryOrStatements ?? []).map((item) => ({
        ...item,
        ...cursorOrStatements[1],
      }));
      enhancedCursorOrStatements = [...firstStatement, ...secondStatement];
    } else {
      cursorOrStatements = [{ _id: isSortDesc ? { $lt: after } : { $gt: after } }];
      const firstStatement = (queryOrStatements ?? []).map((item) => ({
        ...item,
        ...cursorOrStatements[0],
      }));
      enhancedCursorOrStatements = [...firstStatement];
    }

    return enhancedCursorOrStatements.length > 0 ? enhancedCursorOrStatements : cursorOrStatements;
  }

  async cursorPagination({
    query,
    limit,
    offset,
    after,
    sort,
    paginateField,
    enhanceQuery,
  }: {
    query?: FilterQuery<T_DBModel> & T_Enforcement;
    limit: number;
    offset: number;
    after?: string;
    sort?: any;
    paginateField?: string;
    enhanceQuery?: (query: QueryWithHelpers<Array<T_DBModel>, T_DBModel>) => any;
  }): Promise<{ data: T_MappedEntity[]; hasMore: boolean }> {
    const isAfterDefined = typeof after !== 'undefined';
    const sortKeys = Object.keys(sort ?? {});
    const isSortDesc = sortKeys.length > 0 && sort[sortKeys[0]] === -1;

    let findQueryBuilder = this.MongooseModel.find({
      ...query,
    });
    if (isAfterDefined) {
      const orStatements = await this.createCursorBasedOrStatement({
        isSortDesc,
        paginateField,
        after,
        queryOrStatements: query?.$or,
      });

      findQueryBuilder = this.MongooseModel.find({
        ...query,
        $or: orStatements,
      });
    }

    findQueryBuilder.sort(sort).limit(limit + 1);
    if (!isAfterDefined) {
      findQueryBuilder.skip(offset);
    }

    if (enhanceQuery) {
      findQueryBuilder = enhanceQuery(findQueryBuilder);
    }

    const messages = await findQueryBuilder.exec();

    const hasMore = messages.length > limit;
    if (hasMore) {
      messages.pop();
    }

    return {
      data: this.mapEntities(messages),
      hasMore,
    };
  }

  private calcExpireDate(modelName: string, data: FilterQuery<T_DBModel> & T_Enforcement) {
    let startDate: Date = new Date();
    if (data.expireAt) {
      startDate = new Date(data.expireAt);
    }

    switch (modelName) {
      case 'Message':
        if (data.channel === 'in_app') {
          return addDays(
            startDate,
            Number(process.env.MESSAGE_IN_APP_RETENTION_DAYS || DEFAULT_MESSAGE_IN_APP_RETENTION_DAYS)
          );
        } else {
          return addDays(
            startDate,
            Number(process.env.MESSAGE_GENERIC_RETENTION_DAYS || DEFAULT_MESSAGE_GENERIC_RETENTION_DAYS)
          );
        }
      case 'Notification':
        return addDays(
          startDate,
          Number(process.env.NOTIFICATION_RETENTION_DAYS || DEFAULT_NOTIFICATION_RETENTION_DAYS)
        );
      default:
        return null;
    }
  }

  async create(data: FilterQuery<T_DBModel> & T_Enforcement, options: IOptions = {}): Promise<T_MappedEntity> {
    const expireAt = this.calcExpireDate(this.MongooseModel.modelName, data);
    if (expireAt) {
      data = { ...data, expireAt };
    }
    const newEntity = new this.MongooseModel(data);

    const saveOptions = options?.writeConcern ? { w: options?.writeConcern } : {};

    const saved = await newEntity.save(saveOptions);

    return this.mapEntity(saved);
  }

  async insertMany(
    data: FilterQuery<T_DBModel> & T_Enforcement[],
    ordered = false
  ): Promise<{ acknowledged: boolean; insertedCount: number; insertedIds: Types.ObjectId[] }> {
    let result;
    try {
      result = await this.MongooseModel.insertMany(data, { ordered });
    } catch (e) {
      throw new DalException(e.message);
    }

    const insertedIds = result.map((inserted) => inserted._id);

    return {
      acknowledged: true,
      insertedCount: result.length,
      insertedIds,
    };
  }

  async update(
    query: FilterQuery<T_DBModel> & T_Enforcement,
    updateBody: UpdateQuery<T_DBModel>
  ): Promise<{
    matched: number;
    modified: number;
  }> {
    const saved = await this.MongooseModel.updateMany(query, updateBody, {
      multi: true,
    });

    return {
      matched: saved.matchedCount,
      modified: saved.modifiedCount,
    };
  }

  async updateOne(
    query: FilterQuery<T_DBModel> & T_Enforcement,
    updateBody: UpdateQuery<T_DBModel>
  ): Promise<{
    matched: number;
    modified: number;
  }> {
    const saved = await this.MongooseModel.updateOne(query, updateBody);

    return {
      matched: saved.matchedCount,
      modified: saved.modifiedCount,
    };
  }

  async upsertMany(data: (FilterQuery<T_DBModel> & T_Enforcement)[]) {
    const promises = data.map((entry) => this.MongooseModel.findOneAndUpdate(entry, entry, { upsert: true }));

    return await Promise.all(promises);
  }

  async upsert(query: FilterQuery<T_DBModel> & T_Enforcement, data: FilterQuery<T_DBModel> & T_Enforcement) {
    return await this.MongooseModel.findOneAndUpdate(query, data, {
      upsert: true,
      new: true,
      includeResultMetadata: true,
    });
  }

  async bulkWrite(bulkOperations: any, ordered = false): Promise<any> {
    return await this.MongooseModel.bulkWrite(bulkOperations, { ordered });
  }

  protected mapEntity<TData>(data: TData): TData extends null ? null : T_MappedEntity {
    return plainToInstance(this.entity, JSON.parse(JSON.stringify(data))) as any;
  }

  protected mapEntities(data: any): T_MappedEntity[] {
    return plainToInstance<T_MappedEntity, T_MappedEntity[]>(this.entity, JSON.parse(JSON.stringify(data)));
  }
}

interface IOptions {
  writeConcern?: number | 'majority';
}
