import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface DocumentIndexingProps extends cdk.NestedStackProps {
  vpc: ec2.Vpc;
  dbCluster: rds.DatabaseInstance | rds.DatabaseCluster;
  embeddingsEndpoint: sagemaker.CfnEndpoint;
  dataBucket: s3.Bucket;
  architecture: lambda.Architecture;
}

export class DocumentIndexing extends Construct {
  public ingestionQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: DocumentIndexingProps) {
    super(scope, id);

    const { vpc, dbCluster, embeddingsEndpoint, dataBucket, architecture } = props;

    const dataQueue = new sqs.Queue(this, 'DataQueue', {
      visibilityTimeout: cdk.Duration.seconds(600),
    });

    const documentIndexing = new lambda.DockerImageFunction(this, 'DocumentIndexing', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, './functions/document-indexing')),
      architecture,
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      timeout: cdk.Duration.minutes(10),
      memorySize: 3008,
      logRetention: logs.RetentionDays.ONE_DAY,
      environment: {
        REGION_NAME: cdk.Aws.REGION,
        LOG_LEVEL: 'DEBUG',
        DB_SECRET_ID: dbCluster.secret?.secretArn as string,
        EMBEDDINGS_ENDPOINT_NAME: embeddingsEndpoint.attrEndpointName,
      },
    });

    dbCluster.secret?.grantRead(documentIndexing);
    dbCluster.connections.allowDefaultPortFrom(documentIndexing);
    dataBucket.grantReadWrite(documentIndexing);

    documentIndexing.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [embeddingsEndpoint.ref],
      }),
    );

    dataQueue.grantConsumeMessages(documentIndexing);
    documentIndexing.addEventSource(new lambdaEventSources.SqsEventSource(dataQueue));

    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
    });

    this.ingestionQueue = dataQueue;
  }
}
